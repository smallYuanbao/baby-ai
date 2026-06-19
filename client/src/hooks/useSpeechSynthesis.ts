import { useCallback, useRef } from 'react';

/**
 * useSpeechSynthesis — 语音合成（TTS）React Hook
 *
 * ## 数据流定位
 * 该 Hook 位于 AI 回答的 **展示层**：当父组件接收到后端返回的 AI 文本回答后，
 * 调用 `speak(text)` 将文本内容通过浏览器内置的 Web Speech API 朗读出来。
 * 它与 `useAudioRecognition`（语音识别/STT）形成输入-输出闭环：
 *   - useAudioRecognition:  用户语音 → 文本 → 发送给 AI
 *   - useSpeechSynthesis:   AI 文本 → 语音 → 播放给用户
 *
 * ## 职责
 * - 封装浏览器的 SpeechSynthesis API，提供统一的朗读/停止接口
 * - 管理朗读状态（是否正在朗读），通过 useRef 避免不必要的 re-render
 * - 清理 Markdown 标记，将结构化文本转换为适合口语朗读的纯文本
 * - 针对儿童场景调整语速和音高参数
 *
 * ## 平台兼容性
 * - 通过 `isSupported` 标记检测浏览器是否支持 SpeechSynthesis
 * - 在不支持的环境中（如服务端渲染），所有方法安全地静默返回，不抛异常
 * - SpeechSynthesis API 在各浏览器中行为有差异（如 Chrome 的句子级事件 vs Safari 的文档级事件），
 *   本 Hook 基于最通用的 `onstart`/`onend`/`onerror` 事件进行状态追踪
 *
 * ## 关键设计决策
 * - **useRef 而非 useState**：朗读状态变化频繁（开始/结束/错误），不需要触发 React 渲染，
 *   使用 ref 可以避免子树因音频播放状态变化而频繁 re-render
 * - **speak 中自动 cancel**：调用 speak 时先停止当前朗读，避免多个 utterance 堆叠
 * - **纯文本清理**：将 Markdown 语法字符（*_~`#>()等）移除，换行转为中文逗号，
 *   确保 TTS 引擎输出自然流畅的口语
 */

/**
 * 语音合成 Hook
 *
 * @returns {object} 返回值对象
 * @returns {boolean} return.isSupported  - 当前浏览器是否支持 SpeechSynthesis API。
 *   当为 `false` 时，所有其他方法均为安全空操作。
 * @returns {(text: string) => void} return.speak - 朗读指定文本。
 *   自动停止当前正在进行的朗读，清理 Markdown 标记后使用中文语音合成。
 *   在不支持的平台上静默返回，不抛异常。
 * @returns {() => void} return.stop - 立即取消当前朗读。
 *   重置内部朗读状态为 false。在不支持的平台上静默返回。
 * @returns {() => boolean} return.isSpeaking - 返回当前是否正在朗读。
 *   注意：由于使用 useRef 追踪状态，调用此方法不会触发组件 re-render。
 *   状态在 `speak` 调用的 `onstart` 回调中设为 true，
 *   在 `onend` 或 `onerror` 回调中设为 false。
 */
export function useSpeechSynthesis() {
  // 浏览器能力检测：在 SSR/不支持的环境中，isSupported 为 false，
  // 后续所有方法会提前返回，避免调用不存在的 API 导致运行时错误。
  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // 使用 ref 而非 state 追踪朗读状态：
  // - 朗读状态变化不需要触发 UI 更新（这里只影响播放，不影响渲染）
  // - 避免因频繁的 start/end 事件导致组件子树不必要的 re-render
  // - ref 的读写是同步的，`isSpeaking()` 可以立即返回最新值
  const speakingRef = useRef(false);

  /**
   * 朗读指定文本
   *
   * 流程：
   * 1. 安全检查：不支持时静默返回
   * 2. 取消当前朗读：避免多个 utterance 叠加
   * 3. 文本清理：移除 Markdown 标记，换行转逗号
   * 4. 构建 Utterance 对象，设置中文参数
   * 5. 绑定生命周期回调，追踪朗读状态
   * 6. 提交到 TTS 引擎开始朗读
   *
   * @param {string} text - 待朗读的文本，可包含 Markdown 标记（会被自动清理）。
   *   空字符串、纯空白字符或清理后为空的文本会导致静默返回。
   */
  const speak = useCallback((text: string) => {
    // 安全检查：在不支持的浏览器或 SSR 环境中静默返回
    if (!isSupported) return;

    // 清理前一个 utterance，防止多个朗读任务同时进行导致引擎状态混乱。
    // cancel() 是同步的，调用后 speakingRef 会被对应的 onend/onerror 更新，
    // 但为了安全，后续 utterance 的 onstart 会再次将状态设为 true。
    window.speechSynthesis.cancel();

    // 将 Markdown 文本转为口语友好的纯文本：
    // - 第一步：移除 Markdown 格式字符（粗体、斜体、删除线、代码、引用、链接语法、列表标记等）
    // - 第二步：将换行符替换为中文逗号，使 TTS 引擎产生自然停顿而非生硬断句
    // - 第三步：去除首尾空白
    const plainText = text
      .replace(/[*_~`#>\[\]()]/g, '')
      .replace(/\n+/g, '，')
      .trim();

    // 边缘情况：清理后为空字符串（如纯 Markdown 标记文本），静默返回
    if (!plainText) return;

    const utterance = new SpeechSynthesisUtterance(plainText);
    // 语言设为中文，确保中文语音引擎被选用
    utterance.lang = 'zh-CN';
    // 语速 0.9：比默认稍慢，让儿童能更清晰地听清每个字
    utterance.rate = 0.9;
    // 音高 1.05：略微偏高，声音更亲切温和，适合与儿童交流的场景
    utterance.pitch = 1.05;

    // 绑定生命周期回调 —— 这些回调由浏览器异步触发：
    // - onstart: 引擎开始朗读时触发（某些浏览器可能延迟数十毫秒）
    // - onend:   朗读自然完成时触发
    // - onerror: 朗读被中断或出错时触发（如 cancel()、系统音频中断等）
    utterance.onstart = () => { speakingRef.current = true; };
    utterance.onend = () => { speakingRef.current = false; };
    utterance.onerror = () => { speakingRef.current = false; };

    // 将 utterance 提交到浏览器的 TTS 队列。
    // 注意：某些浏览器（如 Chrome）在用户无交互时不播放音频，
    // 调用方应在用户手势（click/touch）上下文中调用此方法。
    window.speechSynthesis.speak(utterance);
  }, [isSupported]);

  /**
   * 立即停止当前朗读
   *
   * 调用 window.speechSynthesis.cancel() 取消当前及队列中的朗读任务，
   * 并同步重置内部状态。cancel() 触发的 onerror/onend 回调也会设置
   * speakingRef.current = false，此处显式重置是为了确保状态立即生效，
   * 不依赖异步回调的执行时机。
   *
   * 在不支持的平台上静默返回。
   */
  const stop = useCallback(() => {
    if (isSupported) {
      window.speechSynthesis.cancel();
      // 同步重置状态，不等待 cancel() 异步触发 onend/onerror。
      // 双重保险：即使在浏览器不触发回调的边缘情况下，状态也会被正确清除。
      speakingRef.current = false;
    }
  }, [isSupported]);

  /**
   * 查询当前是否正在朗读
   *
   * @returns {boolean} true 表示当前有 utterance 正在播放中。
   *   注意：朗读结束后此值不会自动触发 re-render，
   *   因为状态存储在 ref 中而非 state。调用方如需基于此值驱动 UI，
   *   可结合调用方的 state 或使用轮询/事件驱动的方式检测变化。
   */
  const isSpeaking = () => speakingRef.current;

  // 返回稳定的引用：speak 和 stop 通过 useCallback 包裹，依赖 [isSupported]，
  // isSupported 在应用生命周期中不变，因此这些引用在组件整个生命周期中保持稳定。
  return {
    /** 浏览器是否支持语音合成，false 时所有方法为安全空操作 */
    isSupported,
    /** 朗读文本，自动清理 Markdown 标记 */
    speak,
    /** 立即停止朗读，同步重置状态 */
    stop,
    /** 查询朗读状态，基于 ref，不触发 re-render */
    isSpeaking,
  };
}
