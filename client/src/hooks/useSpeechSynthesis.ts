import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * useSpeechSynthesis — 语音合成（TTS）React Hook
 *
 * ## 数据流定位
 * 该 Hook 位于 AI 回答的 **展示层**：当父组件接收到后端返回的 AI 文本回答后，
 * 调用 `speak(id, text)` 将文本内容通过浏览器内置的 Web Speech API 朗读出来。
 * 它与语音识别（STT）形成输入-输出闭环：
 *   - STT: 用户语音 → 文本 → 发送给 AI
 *   - TTS: AI 文本 → 语音 → 播放给用户
 *
 * ## 为什么要把话讲清楚
 * 朗读的输入是 Markdown（语料和回答里都有 `**加粗**`、列表、链接、表格、大量 emoji）。
 * 直接丢给 TTS 会把 URL、星号、emoji 一起念出来 —— 所以先过 {@link toSpeechText}
 * 转成口语文本，再按句切块（{@link splitForSpeech}）。
 *
 * ## 状态
 * `activeId` 是 **调用方给的标识**（这里用消息 id）。调用方据此把正在朗读的那条
 * 消息的按钮切成「停止」，也据此实现「再点一次就停」。
 * 用 state 而不是 ref：按钮文案要跟着变，必须触发重渲染。
 */

/**
 * 单块文本的上限（字符数）。
 *
 * Chrome 的 SpeechSynthesis 对单个 utterance 有已知限制（部分版本约 15 秒就停），
 * 而这个应用的回答动辄几百字。按句切成小块再排队播放，既绕开限制，
 * 也让「停止」能立刻生效（cancel 会清空整个队列）。
 * 中文 TTS 大约每秒 5～6 字，60 字 ≈ 10 秒，留足余量。
 */
const MAX_CHUNK_LENGTH = 60;

/**
 * 中文音色的偏好顺序（按 `name.includes()` 匹配）。
 *
 * 各平台可用的音色完全不同，而且**默认音色经常是最机械的那个**：
 *   - macOS：Tingting（婷婷）是长期公认最自然的中文系统音色
 *   - Chrome：内置的「Google 普通话」质量明显好于系统默认
 *   - Windows：Xiaoxiao / Huihui / Yaoyao 是神经网络音色
 * 找不到就退回第一个 zh-CN 音色，再不行交给引擎默认。
 */
const PREFERRED_VOICE_KEYWORDS = [
  'Tingting',
  '婷婷',
  'Google 普通话',
  'Google 國語',
  'Xiaoxiao',
  '晓晓',
  'Huihui',
  '慧慧',
  'Yaoyao',
  'Meijia',
  '美佳',
  'Sinji',
  '善怡',
];

/** 只保留中文音色 —— 设置面板里列英文音色没有意义。 */
function isChineseVoice(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().startsWith('zh');
}

/**
 * 挑一个音色：用户显式指定的优先，其次是偏好列表，最后退回第一个中文音色。
 *
 * @param voices - 浏览器提供的完整音色列表。
 * @param preferredName - 用户选过的音色名；为空或已不存在时走自动挑选。
 * @returns 选中的音色；列表为空时返回 null（交给引擎默认）。
 */
export function pickChineseVoice(
  voices: SpeechSynthesisVoice[],
  preferredName?: string,
): SpeechSynthesisVoice | null {
  const chinese = voices.filter(isChineseVoice);
  if (chinese.length === 0) return null;

  if (preferredName) {
    const exact = chinese.find((v) => v.name === preferredName);
    if (exact) return exact;
  }

  for (const keyword of PREFERRED_VOICE_KEYWORDS) {
    const hit = chinese.find((v) => v.name.includes(keyword));
    if (hit) return hit;
  }

  return chinese.find((v) => v.lang.toLowerCase() === 'zh-cn') ?? chinese[0] ?? null;
}

/**
 * 把 Markdown 转成适合朗读的纯文本。
 *
 * 顺序有讲究：先处理成对的结构（代码块、链接、表格行），再处理零散的标记字符，
 * 否则 `[文字](url)` 里的括号被提前删掉后，URL 就再也认不出来了。
 *
 * @param markdown - 原始 Markdown 文本。
 * @returns 口语文本；可能为空字符串（纯标记）。
 */
export function toSpeechText(markdown: string): string {
  return (
    markdown
      // --- 先处理"整体结构" ---
      .replace(/```[\s\S]*?```/g, '')                 // 围栏代码块：念出来没有意义，整段跳过
      .replace(/`([^`]+)`/g, '$1')                    // 行内代码：留内容
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')       // 图片 → 只留 alt（通常是空）
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // 链接 → 只留文字，URL 不念
      .replace(/https?:\/\/\S+/g, '')                 // 裸 URL
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')    // 表格分隔行 |---|---|
      .replace(/\|/g, '，')                           // 表格竖线 → 停顿

      // --- 再处理行首标记 ---
      .replace(/^[-*_]{3,}\s*$/gm, '')                // 分割线
      .replace(/^#{1,6}\s+/gm, '')                    // 标题
      .replace(/^>\s?/gm, '')                         // 引用
      .replace(/^\s*[-*+]\s+/gm, '')                  // 无序列表符号
      // 有序列表的「1.」保留：朗读时能听出步骤顺序

      // --- 行内强调标记 ---
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/[*_~`]/g, '')

      // --- emoji ---
      // 语料里 emoji 密度很高（🏷️📖✅🔴），不删的话语音引擎会念出
      // "标签""听诊器"之类的词，或者干脆卡一下。
      // 范围取扩展象形符号 + 常见符号区 + 变体选择符/零宽连接符/键帽。
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu,
        '',
      )

      // --- 标点与空白 ---
      .replace(/[ \t]+/g, ' ')
      .replace(/\n+/g, '，')                          // 换行 → 停顿（生硬断句会念得很僵）
      .replace(/[，,]{2,}/g, '，')                    // 清理重复停顿
      .replace(/([。！？；：])[，\s]+/g, '$1')          // 「。，」「。 」：句末标点后不再补停顿
      .replace(/\s+([。！？；：])/g, '$1')              // 「 。」：标点前的空格也去掉
      .replace(/^[，\s]+|[，\s]+$/g, '')               // 首尾停顿
  );
}

/**
 * 按句子切块，每块不超过 `maxLength` 个字符。
 *
 * 先按句末标点切，再把短句合并到接近上限；单句超长时硬切 ——
 * 宁可断在中间，也不能让一整段超出引擎限制后静默停播。
 *
 * @param text - 已经过 {@link toSpeechText} 的纯文本。
 * @param maxLength - 单块上限。
 * @returns 文本块数组；输入为空时返回空数组。
 */
export function splitForSpeech(text: string, maxLength = MAX_CHUNK_LENGTH): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 用 match 而不是 split：中文句末标点要留在句子里，split 会把它们当分隔符丢掉。
  const sentences = trimmed.match(/[^。！？；!?;]+[。！？；!?;]?/g) ?? [trimmed];

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if (s.length > maxLength) {
      // 单句超长：先把已攒的吐出去，再把这句硬切成 maxLength 一段
      pushCurrent();
      for (let i = 0; i < s.length; i += maxLength) {
        chunks.push(s.slice(i, i + maxLength));
      }
      continue;
    }

    if ((current + s).length > maxLength) pushCurrent();
    current += s;
  }

  pushCurrent();
  return chunks;
}

/**
 * 语音合成 Hook
 *
 * @returns 见 {@link UseSpeechSynthesisResult}。
 */
export interface SpeechSynthesisOptions {
  /** 用户选定的音色名（`SpeechSynthesisVoice.name`）。为空时自动挑一个中文音色。 */
  voiceName?: string;
  /** 语速。默认 0.9（比标准稍慢，方便边做事边听）。 */
  rate?: number;
}

export interface UseSpeechSynthesisResult {
  /** 当前浏览器是否支持 SpeechSynthesis。false 时所有方法为安全空操作。 */
  isSupported: boolean;
  /**
   * 正在朗读的标识（由调用方在 `speak` 时传入）。
   * 朗读结束、出错或被 `stop()` 时回到 null。
   */
  activeId: string | null;
  /** 浏览器可用的中文音色（设置面板用）。 */
  voices: SpeechSynthesisVoice[];
  /** 实际会使用的音色名 —— 用户没选时，这里是自动挑出来的那个。 */
  selectedVoiceName: string | null;
  /** 朗读指定文本。会先停掉当前正在播放的内容。 */
  speak: (id: string, text: string) => void;
  /** 立即停止当前朗读（包括排队中的块）。 */
  stop: () => void;
}

export function useSpeechSynthesis(
  options: SpeechSynthesisOptions = {},
): UseSpeechSynthesisResult {
  const { voiceName, rate = 0.9 } = options;

  // 浏览器能力检测：在不支持的环境（SSR 等）中，后续方法提前返回。
  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * 浏览器可用的音色列表。
   *
   * Chrome 首次调用 `getVoices()` 往往返回空数组，要等 `voiceschanged` 事件
   * 之后才真正加载完 —— 只听一次就定下来，会永远拿不到音色、退回引擎默认。
   */
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!isSupported) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
  }, [isSupported]);

  const chineseVoices = useMemo(() => voices.filter(isChineseVoice), [voices]);
  const voice = useMemo(() => pickChineseVoice(voices, voiceName), [voices, voiceName]);

  /**
   * 每次朗读分配一个自增的 runId。
   *
   * cancel() 会异步触发旧 utterance 的 onend / onerror；没有 runId 的话，
   * 那些回调会把**新一次**朗读的状态误清成 null（表现：点了 B，A 的结束
   * 回调把按钮切回「朗读」）。回调里比对 runId 就能识别出"这是上一轮的"。
   */
  const runIdRef = useRef(0);

  const speak = useCallback(
    (id: string, text: string) => {
      if (!isSupported) return;

      // 先换 runId 再 cancel：cancel 触发的旧回调会立刻看到过期的 runId。
      runIdRef.current += 1;
      const runId = runIdRef.current;
      window.speechSynthesis.cancel();

      const chunks = splitForSpeech(toSpeechText(text));
      if (chunks.length === 0) {
        setActiveId(null);
        return;
      }

      setActiveId(id);

      chunks.forEach((chunk, index) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        // 显式指定音色。不设的话浏览器会用它自己的默认 zh-CN 音色，
        // 各平台差异极大（Mac 默认未必是婷婷，Chrome 默认未必是 Google 普通话）。
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang ?? 'zh-CN';
        utterance.rate = rate;
        utterance.pitch = 1.05; // 略微偏高，声音更温和

        const finish = () => {
          if (runIdRef.current !== runId) return; // 已被新的朗读或 stop() 取代
          // 中间某块出错时后面的块不会自动播，直接收尾，别让按钮一直显示「停止」
          if (index !== chunks.length - 1) window.speechSynthesis.cancel();
          setActiveId(null);
        };

        // 只在最后一块挂 onend：前面几块结束时不该把状态清掉。
        if (index === chunks.length - 1) utterance.onend = finish;
        utterance.onerror = finish;

        window.speechSynthesis.speak(utterance);
      });
    },
    [isSupported, voice, rate],
  );

  const stop = useCallback(() => {
    if (!isSupported) return;
    runIdRef.current += 1; // 让所有在途回调失效
    window.speechSynthesis.cancel();
    setActiveId(null);
  }, [isSupported]);

  return {
    isSupported,
    activeId,
    voices: chineseVoices,
    selectedVoiceName: voice?.name ?? null,
    speak,
    stop,
  };
}
