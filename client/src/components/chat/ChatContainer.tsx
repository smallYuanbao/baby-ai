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

import { useCallback } from 'react';
import { useChat } from '../../hooks/useChat';
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis';
import { MessageList } from './MessageList';
import { ChatInput } from '../input/ChatInput';
import { ErrorBanner } from '../shared/ErrorBanner';
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

  return (
    <div className={styles.wrapper}>
      {/* ---- Clear-chat toolbar ---- */}
      {/* Only shown when there is at least one message to clear. */}
      {messages.length > 0 && (
        <div className={styles.toolbar}>
          <button
            onClick={clearChat}
            className={styles.clearButton}
          >
            <svg className={styles.clearIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            清空对话
          </button>
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
      />
    </div>
  );
}
