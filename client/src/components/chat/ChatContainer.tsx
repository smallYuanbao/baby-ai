/**
 * @file ChatContainer
 * @description Top-level chat layout component that orchestrates the chat experience.
 *
 * Composes useChat (message state / streaming / error / actions), useSpeechSynthesis
 * (TTS support / speak / stop), MessageList, ChatInput, and ErrorBanner into a
 * single full-height flex column.  Handles conditional rendering of the clear-chat
 * toolbar and error banner, and wires the "read aloud" callback through to the
 * speech-synthesis hook.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChat } from '../../hooks/useChat';
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis';
import { MessageList } from './MessageList';
import { ChatInput } from '../input/ChatInput';
import { ErrorBanner } from '../shared/ErrorBanner';
import { ReferencePanel } from './ReferencePanel';
import styles from './ChatContainer.module.less';

/**
 * Top-level chat layout component.
 *
 * Responsibilities:
 * - Delegates chat state management to {@link useChat}.
 * - Delegates TTS playback to {@link useSpeechSynthesis}.
 * - Renders a clear-chat toolbar (visible only when there are messages).
 * - Renders an error banner (visible only when an error is present).
 * - Renders the scrollable message list and the fixed-bottom input area.
 *
 * @returns A full-height flex container holding the chat UI.
 */
export function ChatContainer() {
  const {
    messages,
    isStreaming,
    error,
    sendMessage,
    retryLast,
    clearChat,
    stopGenerating,
  } = useChat();

  const { isSupported: ttsSupported, speak, stop: stopSpeaking } = useSpeechSynthesis();

  /**
   * Stable callback that invokes the TTS `speak` function when the browser
   * supports speech synthesis.
   */
  const handleReadAloud = useCallback(
    (text: string) => {
      if (ttsSupported) speak(text);
    },
    [ttsSupported, speak],
  );

  // 右侧引用面板展示「最新一条带引用的助手回答」的来源。
  // 倒着找:流式期间的中间态消息可能还没有 references,取最近一条有内容的。
  const latestReferences = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user' && m.references?.length) return m.references;
    }
    return [];
  }, [messages]);

  /** 是否至少问过一次（存在助手消息，含正在生成的那条占位）。
   *  注意要和 isStreaming 配合看：流式期间引用为空是正常的中间态（见 ReferencePanel）。 */
  const hasAnswered = useMemo(
    () => messages.some((m) => m.role === 'assistant'),
    [messages],
  );

  /** 清空对话的二次确认是否展开。 */
  const [confirmingClear, setConfirmingClear] = useState(false);

  /** Esc 取消确认 —— 展开后不想清了，不该被迫去点「取消」。 */
  useEffect(() => {
    if (!confirmingClear) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmingClear(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingClear]);

  const handleConfirmClear = useCallback(() => {
    clearChat();
    setConfirmingClear(false);
  }, [clearChat]);

  return (
    <div className={styles.wrapper}>
      {/* 左：聊天区（工具栏 / 消息 / 输入）；右：引用面板 */}
      <div className={styles.chatColumn}>
      {/* ---- Clear-chat toolbar ---- */}
      {/* Only shown when there is at least one message to clear. */}
      {messages.length > 0 && (
        <div className={styles.toolbar}>
          {confirmingClear ? (
            // 二次确认。用就地展开而不是弹窗：对话只存在内存里，清掉不可撤销，
            // 而且这个按钮还兼任「放弃正在生成的回答」，误点代价不小；
            // 但弹窗要额外管焦点、遮罩和 Esc，成本高得多，就地确认够用了。
            //
            // 文案区分状态：正在生成时要说清「这会中止回答」，否则用户不知道
            // 自己顺手把生成也掐了。
            <div className={styles.confirmRow}>
              <span className={styles.confirmText}>
                {isStreaming ? '正在生成回答，确定中止并清空？' : '确定清空这段对话？'}
              </span>
              <button
                onClick={handleConfirmClear}
                className={styles.confirmYes}
                autoFocus
              >
                确定清空
              </button>
              <button
                onClick={() => setConfirmingClear(false)}
                className={styles.confirmNo}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingClear(true)}
              className={styles.clearButton}
            >
              <svg className={styles.clearIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              清空对话
            </button>
          )}
        </div>
      )}

      {/* ---- Error banner ---- */}
      {/* useChat resets the error state on the next send, so onDismiss is a no-op. */}
      {error && (
        <ErrorBanner
          message={error}
          onRetry={retryLast}
          onDismiss={() => {/* useChat handles error clearing on next send */}}
        />
      )}

      {/* ---- Message list ---- */}
      <MessageList
        messages={messages}
        onSuggestionClick={sendMessage}
        onReadAloud={handleReadAloud}
      />

      {/* ---- Input area (fixed at bottom) ---- */}
      <ChatInput
        onSend={sendMessage}
        disabled={isStreaming}
        isStreaming={isStreaming}
        onStop={stopGenerating}
      />
      </div>

      <ReferencePanel references={latestReferences} isStreaming={isStreaming} hasAnswer={hasAnswered} />
    </div>
  );
}
