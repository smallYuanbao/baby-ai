/**
 * ChatInput — The primary chat compose bar rendered at the bottom of the chat screen.
 *
 * Responsibilities:
 * - Manages local text state (controlled textarea)
 * - Integrates file upload (via {@link useFileUpload}) and speech recognition
 *   (via {@link useSpeechRecognition})
 * - Auto-resizes the textarea up to a max height of 120px
 * - Dispatches the composed message (text + optional file) to the parent via
 *   the `onSend` callback
 * - Renders an inline file preview when a file is attached
 *
 * @module ChatInput
 */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { FileUploadButton } from './FileUploadButton';
import { FilePreview } from './FilePreview';
import { VoiceToggle } from '../shared/VoiceToggle';
import { useFileUpload } from '../../hooks/useFileUpload';
import { api } from '../../services/api';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import styles from './ChatInput.module.less';

/**
 * 输入框的高度区间（px）。
 *
 * 下限对齐右侧发送按钮的 44px（WCAG 触摸目标最小值），
 * 上限避免输入框长高后把上方的消息区挤没。
 * 自增高逻辑和 JSX 上的内联样式共用这两个值，别在两处各写一遍。
 */
const MIN_TEXTAREA_HEIGHT = 44;
const MAX_TEXTAREA_HEIGHT = 120;

/**
 * Props accepted by the {@link ChatInput} component.
 */
interface ChatInputProps {
  /**
   * Callback fired when the user submits a message.
   * @param message - The trimmed text content.
   * @param fileId   - Optional server-side ID of an uploaded file.
   * @param fileName - Optional original file name (for display purposes).
   */
  onSend: (message: string, fileId?: string, fileName?: string) => void;
  /**
   * When `true`, the entire input area (textarea, buttons) is disabled.
   * Useful while the assistant is generating a response or during loading states.
   */
  disabled?: boolean;
  /**
   * When `true`, the send button is replaced by a stop button so the user can
   * interrupt the in-flight generation. The rest of the input stays disabled.
   */
  isStreaming?: boolean;
  /**
   * Callback fired when the stop button is clicked. Should abort the active
   * stream and finalise the partial assistant message.
   */
  onStop?: () => void;
}

/**
 * Renders the chat input bar including:
 * - A file-attachment button (with inline file preview when a file is selected)
 * - A voice-input toggle (only rendered when the browser supports speech recognition)
 * - An auto-resizing textarea for typed input
 * - A send button (which also acts as a visual affordance for submission)
 *
 * Keyboard shortcut: `Enter` sends the message; `Shift + Enter` inserts a newline.
 */
export function ChatInput({ onSend, disabled, isStreaming, onStop }: ChatInputProps) {
  /** Raw text value of the input area. */
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 后端能收哪些格式 / 多大。**不再由前端自己写死一份** —— 两边各写一份必然脱节
   * （曾经前端列了 9 种、后端只收 2 种，选个 Word 必然撞墙且毫无提示）。
   * 接口没返回或失败时退回保守默认值，界面照常可用。
   */
  const [uploadFormats, setUploadFormats] = useState<{ extensions: string[]; maxFileSizeMB: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.uploadFormats()
      .then((f) => { if (!cancelled) setUploadFormats(f); })
      .catch(() => { /* 拉不到就用下面的默认值，不影响上传 */ });
    return () => { cancelled = true; };
  }, []);

  const { fileState, uploadError, clearUploadError, inputRef, selectFile, handleFileChange, clearFile } =
    useFileUpload({ maxFileSizeMB: uploadFormats?.maxFileSizeMB });

  /** 给 <input accept> 用。默认值是"后端目前确实支持的"，不是猜的。 */
  const acceptExtensions = uploadFormats?.extensions ?? ['pdf', 'txt'];
  const acceptAttr = acceptExtensions.map((e) => `.${e}`).join(',');
  const { isSupported: voiceSupported, isListening, interimText, startListening, stopListening } = useSpeechRecognition();

  /**
   * 文件还在上传中。
   *
   * 上传期间必须**禁止发送**：此刻 `fileState.fileId` 还是 undefined，发出去的消息
   * 不带附件（后端按"没有文件"处理），而 `clearFile()` 又会立刻清掉预览 ——
   * 那条上传请求还在飞，回来时发现 `prev` 已是 null，结果被丢弃。
   * 用户看到的就是「文件闪没了，助手答了一个根本没读到附件的问题」。
   */
  const isUploading = Boolean(fileState?.uploading);

  // Sync live speech-recognition transcript into the textarea while listening.
  useEffect(() => {
    if (interimText) {
      setText(interimText);
    }
  }, [interimText]);

  /** Toggles voice recognition on/off. */
  const handleVoiceToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  /**
   * Adjusts the textarea height to fit its content.
   * Resets to 'auto' first so `scrollHeight` reflects the real content height,
   * then clamps to a maximum of 120px to prevent the input from overtaking the screen.
   */
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight **含 padding 但不含 border**，而全局 box-sizing 是 border-box
    // （height 含边框）。直接把 scrollHeight 赋给 height 会少算上下边框那 2px，
    // 内容区永远差一点点 → 输入框右侧常驻一条滚动条。
    // offsetHeight - clientHeight 正好是上下边框总高。
    const borderY = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borderY, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  /**
   * Validates, dispatches the message, and resets local state.
   * No-ops when the text is blank or the input is disabled.
   */
  const handleSend = useCallback(() => {
    // 上传中也拦掉 —— 回车不走按钮的 disabled，必须在这里再判一次。
    if (!text.trim() || disabled || isUploading) return;
    onSend(text.trim(), fileState?.fileId, fileState?.file?.name);
    setText('');
    clearFile();
    // Collapse the textarea back to a single line after sending.
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, disabled, isUploading, fileState, onSend, clearFile]);

  /**
   * Keyboard handler — `Enter` (without Shift) sends, `Shift+Enter` inserts a
   * newline so the user can compose multi-line messages.
   *
   * 中文/日文输入法**用回车确认候选词**，那个回车不是「发送」。所以必须先判断
   * 当前是否处于输入法组词状态，否则打字打到一半敲回车就会把半截拼音发出去。
   * `keyCode === 229` 是部分浏览器在组词期间给的占位值，一并挡掉（isComposing
   * 在个别浏览器上结束得偏早，两个条件一起判断更稳）。
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      handleSend();
    },
    [handleSend],
  );

  /** Updates the controlled text state and re-measures the textarea height. */
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustTextareaHeight();
    },
    [adjustTextareaHeight],
  );

  return (
    <div className={styles.wrapper}>
      {/* File preview — only visible when a file has been selected but not yet sent/cleared. */}
      {fileState && (
        <div className={styles.filePreview}>
          <FilePreview
            fileName={fileState.file.name}
            preview={fileState.preview}
            uploading={fileState.uploading}
            onRemove={clearFile}
            parentingRelated={fileState?.parentingRelated}
            summary={fileState?.summary}
          />
        </div>
      )}

      {/*
        上传失败提示。
        没有这一段的话，用户选了一个后端不支持的格式（或超大文件），看到的就是
        「缩略图闪一下 → 消失，什么都不说」—— 界面没有坏，但用户无法知道原因。
        点一下可关闭。
      */}
      {uploadError && (
        <div className={styles.uploadError} role="alert">
          <span>⚠️ {uploadError}</span>
          <button onClick={clearUploadError} className={styles.uploadErrorClose} aria-label="关闭提示">✕</button>
        </div>
      )}

      {/* Main input row: attachment button, voice toggle, textarea, send button. */}
      <div className={styles.inputArea}>
        {/* Hidden file input triggered by the file-attachment button. */}
        <div className={styles.attachButton}>
          <FileUploadButton
            inputRef={inputRef}
            onChange={handleFileChange}
            disabled={disabled}
            accept={acceptAttr}
          />
        </div>

        {/* Voice-input toggle — visible only when the browser supports the Web Speech API. */}
        <div className={styles.micButton}>
          <VoiceToggle
            isListening={isListening}
            isSupported={voiceSupported}
            onToggle={handleVoiceToggle}
            disabled={disabled}
          />
        </div>

        {/* Auto-resizing textarea for the user's typed message. */}
        <div className={styles.textareaWrapper}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder="输入你的育儿问题..."
            disabled={disabled}
            rows={1}
            className={styles.textarea}
            style={{
              minHeight: `${MIN_TEXTAREA_HEIGHT}px`,
              maxHeight: `${MAX_TEXTAREA_HEIGHT}px`,
            }}
          />
        </div>

        {/* While streaming, swap the send button for a stop button so the user
            can interrupt generation; otherwise show the normal send button. */}
        {isStreaming ? (
          <button
            onClick={onStop}
            className={styles.stopButton}
            title="停止生成"
            aria-label="停止生成"
          >
            <svg className={styles.stopIcon} viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled || isUploading}
            className={styles.sendButton}
            title={isUploading ? '文件上传中，稍候即可发送' : '发送消息'}
            // aria-label would be redundant here because `title` already provides
            // an accessible name and the SVG is decorative.
          >
            <svg className={styles.sendIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        )}
      </div>

      {/*
        顶替提示行而不是另起一条 —— 上传中短暂地把「为什么按了回车没反应」说清楚，
        否则按钮变灰、回车无反应，看起来像卡死了。
      */}
      <p className={styles.hint}>
        {isUploading ? '文件上传中，完成后才能发送' : '按 Enter 发送，Shift + Enter 换行'}
      </p>
    </div>
  );
}
