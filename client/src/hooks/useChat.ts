import { useState, useRef, useCallback } from 'react';
import { api } from '../services/api';
import { useSSE } from './useSSE';
import type { Message } from '../types/chat';

/**
 * @file useChat.ts — Core chat conversation hook
 *
 * This hook owns the full lifecycle of a chat conversation:
 * - Message list state (user and assistant messages)
 * - Message sending via the {@link api.chatSSE} SSE endpoint
 * - Streaming token consumption through {@link useSSE}
 * - History windowing (last 8 rounds / 16 messages max)
 * - Error recovery (retry the last failed message)
 * - Session cleanup (disconnect SSE, reset state)
 *
 * ## Data flow
 *
 * ```
 * User input (sendMessage)
 *   → append user Message
 *   → append empty streaming assistant Message
 *   → build history snapshot from current messages
 *   → call api.chatSSE → useSSE.connect → SSE stream
 *       → onToken: append token text to assistant message
 *       → onReferences: attach sources to assistant message
 *       → onDone: mark assistant message done, clear isStreaming
 *       → onError: mark assistant message as error, surface error
 *   → retryLast: find last failed pair, remove them, re-invoke sendMessage
 *   → clearChat: disconnect SSE, reset all state, rotate session ID
 * ```
 */

/**
 * Maximum number of conversation rounds included in history context.
 * Each round = 1 user message + 1 assistant response, so 8 rounds = 16 messages.
 */
const MAX_HISTORY_ROUNDS = 8;

/**
 * Generate a unique message ID.
 *
 * Combines current timestamp with a random base-36 suffix for uniqueness
 * across rapid message creation.
 *
 * @returns A unique message ID string (e.g. `"msg_1718832000000_a3f9b1c"`).
 */
function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Core chat hook — manages the full conversation lifecycle.
 *
 * Combines React state for messages and streaming status with the
 * {@link useSSE} hook for Server-Sent Events consumption. Exposes
 * imperative actions (`sendMessage`, `retryLast`, `clearChat`) for
 * the UI layer.
 *
 * ## State managed
 *
 * - `messages` — ordered list of {@link Message} objects (user + assistant).
 * - `isStreaming` — whether an assistant response is currently being received.
 * - `error` — human-readable string for the last error (user-facing).
 * - `sessionIdRef` — opaque session identifier rotated on `clearChat`.
 *   Currently stored via `useRef` (not surfaced to React) so it is
 *   stable across re-renders but reset manually on clear.
 *
 * ## History windowing
 *
 * Only the most recent {@link MAX_HISTORY_ROUNDS} rounds (up to 16 messages)
 * are sent with each request. Streaming and error messages are excluded
 * from history so the server never sees incomplete or failed turns.
 *
 * ## Edge cases
 *
 * - **Empty/whitespace input**: silently ignored in `sendMessage`.
 * - **Concurrent sends blocked**: if `isStreaming` is true, `sendMessage`
 *   returns immediately without sending.
 * - **Stale closure**: `sendMessage` reads the current `messages` array
 *   from its closure to build history; this snapshot may be slightly stale
 *   if React batches are pending, which is acceptable since only completed
 *   messages are included and the difference is at most one render cycle.
 * - **Retry after non-user message**: `retryLast` validates that the
 *   message preceding the failed assistant message is actually a user
 *   message before re-sending.
 * - **SSE cleanup on unmount**: delegated to `useSSE`; this hook only
 *   calls `disconnect` on explicit `clearChat`.
 *
 * @returns An object with the following properties:
 *
 *   **State**
 *   - `messages: Message[]` — all messages in the conversation, newest last.
 *   - `isStreaming: boolean` — `true` while an assistant response is
 *     being streamed in.
 *   - `error: string | null` — the last error message, or `null` if clean.
 *   - `connectionState: string` — current SSE connection state from `useSSE`
 *     (e.g. `"connecting"`, `"connected"`, `"disconnected"`).
 *
 *   **Actions**
 *   - `sendMessage(text, fileId?, fileName?)` — send a user message and
 *     begin streaming the assistant response.
 *   - `retryLast()` — locate the last failed assistant message, remove
 *     it and its preceding user message, then re-send.
 *   - `clearChat()` — disconnect the SSE stream, reset all state, and
 *     rotate the session ID for a fresh conversation.
 *   - `disconnect()` — disconnect the SSE stream immediately without
 *     resetting message state.
 */
export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(generateId());

  // Token batching: accumulate tokens in a ref, flush on a 50 ms timer
  // to reduce re-render frequency during fast streams.
  const tokenBatchRef = useRef<string[]>([]);
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable reference to the current streaming message ID for the flush callback.
  const streamingMsgIdRef = useRef<string>('');

  /** Flush accumulated tokens to state, then clear the batch and timer. */
  const flushTokenBatch = useCallback(() => {
    const chunk = tokenBatchRef.current.join('');
    tokenBatchRef.current = [];
    tokenTimerRef.current = null;
    if (chunk) {
      const msgId = streamingMsgIdRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, content: m.content + chunk } : m,
        ),
      );
    }
  }, []);

  const { connectionState, connect, disconnect } = useSSE();

  /**
   * Send a user message and stream the assistant response via SSE.
   *
   * ## Side effects (in order)
   *
   * 1. Clears any previous error state.
   * 2. Appends a completed user {@link Message} to the list.
   * 3. Appends an empty assistant message with `isStreaming: true`.
   * 4. Sets `isStreaming` to block concurrent sends.
   * 5. Builds a history snapshot from completed, non-error messages,
   *    limited to the last {@link MAX_HISTORY_ROUNDS} rounds.
   * 6. Opens an SSE connection; token callbacks mutate the placeholder
   *    assistant message immutably via `setMessages`.
   * 7. On `onDone`: marks the assistant message as complete and clears
   *    the streaming flag.
   * 8. On `onError`: marks the assistant message as errored, stores the
   *    error text, and clears the streaming flag.
   *
   * ## Edge cases
   *
   * - If `text` is empty or whitespace-only, the call is silently ignored.
   * - If a stream is already in progress (`isStreaming === true`), the
   *   call returns immediately — only one stream at a time is allowed.
   * - History includes up to `MAX_HISTORY_ROUNDS * 2 - 1` messages
   *   (15 messages = 7.5 rounds) so the current user message becomes
   *   the 16th, completing 8 full rounds on the server side.
   *
   * @param text - The user's message text (will be trimmed).
   * @param fileId - Optional ID of an uploaded file to attach.
   * @param fileName - Optional display name of the attached file.
   * @returns A promise that resolves when the SSE stream finishes
   *   (either `onDone` or `onError` fires).
   */
  const sendMessage = useCallback(
    async (text: string, fileId?: string, fileName?: string) => {
      // Guard: ignore empty input and prevent concurrent streams
      if (!text.trim() || isStreaming) return;

      // Clear any error from a previous failed attempt
      setError(null);

      // Append the user message to the conversation
      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content: text.trim(),
        isStreaming: false,
        timestamp: Date.now(),
        fileId,
        fileName,
      };

      setMessages((prev) => [...prev, userMessage]);

      // Placeholder assistant message — content will be filled token-by-token
      const aiMessageId = generateId();
      const aiMessage: Message = {
        id: aiMessageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, aiMessage]);
      // Track the streaming message ID for token batching flush
      streamingMsgIdRef.current = aiMessageId;
      // Guard active to prevent concurrent sends
      setIsStreaming(true);

      // Build history snapshot: only completed, non-error messages
      // Limit to (MAX_HISTORY_ROUNDS * 2 - 1) so the server receives
      // the current user message plus up to 15 prior messages = 8 rounds.
      const history = [
        ...messages
          .filter((m) => !m.isStreaming && !m.error)
          .slice(-(MAX_HISTORY_ROUNDS * 2 - 1))
          .map((m) => ({
            role: m.role,
            content: m.content,
          })),
      ];

      // Open SSE connection and stream the assistant response
      // The factory callback defers API call construction until connect()
      // has set up the underlying EventSource.
      await connect(
        () => api.chatSSE(text.trim(), history, sessionIdRef.current, fileId),
        {
          // --- Token streaming (batched) ---
          // Tokens are accumulated in a ref and flushed every 50 ms to reduce
          // re-render frequency. Each flush appends the entire batch as one
          // string, so ReactMarkdown re-parses far fewer times.
          onToken: (tokenText: string) => {
            tokenBatchRef.current.push(tokenText);
            if (!tokenTimerRef.current) {
              tokenTimerRef.current = setTimeout(flushTokenBatch, 50);
            }
          },

          // --- Source references ---
          // The SSE endpoint may emit a references event with cited sources.
          // Normalise the payload (array or {references: [...]}) and attach.
          onReferences: (references: unknown) => {
            // useSSE may deliver the raw event data; handle both shapes
            const refs = Array.isArray(references)
              ? references
              : (references as any)?.references || [];
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMessageId ? { ...m, references: refs } : m,
              ),
            );
          },

          // --- Stream completion ---
          // Flush any remaining batched tokens, then mark the message done.
          onDone: () => {
            if (tokenTimerRef.current) {
              clearTimeout(tokenTimerRef.current);
              tokenTimerRef.current = null;
            }
            flushTokenBatch();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMessageId ? { ...m, isStreaming: false } : m,
              ),
            );
            setIsStreaming(false);
          },

          // --- Stream error ---
          // Flush remaining tokens before surfacing the error.
          onError: (err: { code: string; message: string }) => {
            if (tokenTimerRef.current) {
              clearTimeout(tokenTimerRef.current);
              tokenTimerRef.current = null;
            }
            flushTokenBatch();
            setError(err.message);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMessageId
                  ? { ...m, isStreaming: false, error: err.message }
                  : m,
              ),
            );
            setIsStreaming(false);
          },
        },
      );
    },
    [messages, isStreaming, connect, flushTokenBatch],
  );

  /**
   * Retry the last failed assistant message.
   *
   * Finds the most recent message with an `error` property, validates
   * that its predecessor is a user message, removes the failed pair from
   * the list, and re-invokes {@link sendMessage} with the original user
   * input and file attachment.
   *
   * ## Edge cases
   *
   * - If no message has an error, this is a no-op.
   * - If the failed message is not preceded by a user message (should
   *   not happen in normal flow), the call is silently ignored.
   * - Removes the failed assistant message AND its preceding user message
   *   so `sendMessage` re-creates both fresh — this avoids duplicating
   *   the user message in the conversation.
   *
   * @returns `void` — the operation is fire-and-forget; `sendMessage`
   *   will update state as the stream progresses.
   */
  const retryLast = useCallback(() => {
    // Walk backwards to find the most recent failed message
    const lastFailed = [...messages].reverse().find((m) => m.error);
    if (!lastFailed) return;

    const lastFailedIndex = messages.findIndex((m) => m.id === lastFailed.id);
    // The message immediately before a failed assistant message must be a
    // user message — otherwise the conversation structure is unexpected
    // and we bail out to avoid corrupting the message list.
    const userMsg = messages[lastFailedIndex - 1];
    if (!userMsg || userMsg.role !== 'user') return;

    // Remove the failed assistant message from the list. The user message
    // at index (lastFailedIndex - 1) is also dropped; sendMessage will
    // re-create both.
    setMessages((prev) => prev.slice(0, lastFailedIndex));
    setError(null);

    // Re-send the original user input with any file attachment
    sendMessage(userMsg.content, userMsg.fileId, userMsg.fileName);
  }, [messages, sendMessage]);

  /**
   * Clear the conversation and reset all state.
   *
   * Performs a hard reset of the chat session:
   *
   * 1. Disconnects the active SSE stream (if any) to stop in-flight data.
   * 2. Empties the message list.
   * 3. Clears the error state.
   * 4. Resets the streaming flag in case `disconnect` arrives between
   *    `onDone`/`onError` and `setIsStreaming(false)`.
   * 5. Rotates the session ID so the next request starts a fresh
   *    conversation on the server.
   *
   * ## Cleanup considerations
   *
   * - `disconnect()` is called first to tear down the SSE EventSource
   *   before React state updates, avoiding a potential race where a
   *   late-arriving token could land on a cleared message list.
   * - `sessionIdRef` is a `useRef` — rotating it does not trigger a
   *   re-render, which is fine because it is only read at `sendMessage`
   *   time (currently unused in the request payload but reserved for
   *   future server-side session tracking).
   *
   * @returns `void`
   */
  const clearChat = useCallback(() => {
    // Tear down SSE first to prevent late-arriving events on empty state
    disconnect();
    // Clear any pending token batch timer
    if (tokenTimerRef.current) {
      clearTimeout(tokenTimerRef.current);
      tokenTimerRef.current = null;
    }
    tokenBatchRef.current = [];
    // Reset all React state to initial values
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    // Rotate session ID for a clean server-side conversation
    sessionIdRef.current = generateId();
  }, [disconnect]);

  /**
   * Stop the in-flight assistant generation, keeping whatever has already
   * been streamed.
   *
   * ## Why this exists
   *
   * While `isStreaming` is true the send button toggles into a "stop" button.
   * Stopping is a *soft* abort: we disconnect the SSE stream (which triggers
   * the backend's `request.is_disconnected()` check so it stops generating),
   * flush any tokens still sitting in the 50 ms batch buffer, finalise the
   * placeholder message with its partial content, and release the streaming
   * lock so the user can immediately send a follow-up.
   *
   * Contrast with {@link clearChat}, which also disconnects but additionally
   * wipes the message list and rotates the session ID.
   *
   * @returns `void` — fire-and-forget; the streaming message is finalised
   *   synchronously and the next `sendMessage` is unblocked.
   */
  const stopGenerating = useCallback(() => {
    // Abort the SSE fetch. The backend's is_disconnected() check notices the
    // client is gone and stops generating (see llm.py).
    disconnect();
    // Flush tokens still buffered so the user keeps the partial answer.
    if (tokenTimerRef.current) {
      clearTimeout(tokenTimerRef.current);
      tokenTimerRef.current = null;
    }
    flushTokenBatch();
    // Finalise the streaming message: keep its content, clear the streaming flag.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === streamingMsgIdRef.current ? { ...m, isStreaming: false } : m,
      ),
    );
    // Release the send lock.
    setIsStreaming(false);
  }, [disconnect, flushTokenBatch]);

  return {
    messages,
    isStreaming,
    error,
    connectionState,
    sendMessage,
    retryLast,
    clearChat,
    stopGenerating,
    disconnect,
  };
}
