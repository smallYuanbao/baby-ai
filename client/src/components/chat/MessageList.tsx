import type { Message } from '../../types/chat';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { useScrollToBottom } from '../../hooks/useScrollToBottom';
import styles from './MessageList.module.less';

/**
 * @fileoverview MessageList — the main chat message container.
 *
 * Renders the full conversation history as a scrollable list of {@link MessageBubble}
 * components. When the message array is empty, it falls back to the {@link EmptyState}
 * view so the user sees suggested prompts instead of a blank screen.
 *
 * The component also manages scroll behaviour:
 * - Auto-scrolls to the bottom on every new message (via {@link useScrollToBottom}).
 * - Shows a "scroll to bottom" floating button when the user has scrolled up.
 * - Includes a trailing spacer so the last message sits comfortably above the input area.
 */

/**
 * Props accepted by the {@link MessageList} component.
 */
interface MessageListProps {
  /** The ordered list of chat messages to display (oldest first). */
  messages: Message[];
  /** Called when the user taps a suggestion pill inside the empty state. */
  onSuggestionClick: (text: string) => void;
  /** Optional callback to read a message aloud via TTS. */
  onReadAloud?: (text: string) => void;
}

/**
 * The scrollable message list for a chat conversation.
 *
 * Two distinct layouts are rendered depending on whether messages exist:
 * 1. **Empty state** — shows suggestion pills so the user can start a conversation.
 * 2. **Message list** — renders each message as a {@link MessageBubble}, with
 *    auto-scroll and a "back to bottom" button when scrolled up.
 *
 * @param props - See {@link MessageListProps}.
 * @returns A React element wrapping either an empty state or the message history.
 */
export function MessageList({ messages, onSuggestionClick, onReadAloud }: MessageListProps) {
  // Auto-scroll behaviour: the hook re-scrolls whenever `messages` changes.
  const { containerRef, showScrollButton, scrollToBottom, handleScroll } =
    useScrollToBottom([messages]);

  // No messages yet — render the empty-state view with prompt suggestions.
  if (messages.length === 0) {
    return (
      <div className={styles.emptyWrapper} ref={containerRef}>
        <EmptyState onSuggestionClick={onSuggestionClick} />
      </div>
    );
  }

  // Messages exist — render the scrollable message history plus a "scroll to
  // bottom" floating button that appears when the user has scrolled away from
  // the latest message.
  return (
    <div className={styles.wrapper}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={styles.scrollArea}
      >
        {/* Render each message as a bubble; the last one gets a special flag
            so it can e.g. show a read-aloud affordance. */}
        {messages.map((msg, index) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isLast={index === messages.length - 1}
            onReadAloud={onReadAloud}
          />
        ))}
        {/* 底部留白 — extra spacing below the last message so it is not
            hidden behind the input bar or other fixed UI elements. */}
        <div className={styles.spacer} />
      </div>

      {/* 回到底部按钮 — floating button that lets the user jump back to the
          most recent message when they have scrolled up into history. */}
      {showScrollButton && (
        <button
          onClick={() => scrollToBottom()}
          className={`${styles.scrollButton} animate-fade-in`}
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}
