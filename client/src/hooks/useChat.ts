import { useState, useRef, useCallback, useEffect } from 'react';
import { api, type StoredSessionMessage } from '../services/api';
import { useSSE } from './useSSE';
import type { Message } from '../types/chat';
import { normalizeReferences } from '../utils/reference';

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
 * 当前会话 id 在 localStorage 里的 key。
 *
 * 只存 sessionId，不存消息正文 —— 正文由服务端按 session_id 保存，
 * 刷新后走 `GET /api/sessions/{id}` 拉回来。这样多端打开的是同一份对话，
 * 也不会因为 localStorage 的 5MB 上限而丢消息。
 */
const SESSION_ID_STORAGE_KEY = 'baby-ai-session-id';

/** 读取上次的会话 id；没有就生成一个并立刻持久化。 */
function loadOrCreateSessionId(): string {
  try {
    const saved = localStorage.getItem(SESSION_ID_STORAGE_KEY);
    if (saved) return saved;
    const id = generateId();
    localStorage.setItem(SESSION_ID_STORAGE_KEY, id);
    return id;
  } catch {
    // 隐私模式等场景 localStorage 不可用：退化成"刷新即新会话"
    return generateId();
  }
}

/** 持久化会话 id（换新会话时调用）。 */
function persistSessionId(sessionId: string): void {
  try {
    localStorage.setItem(SESSION_ID_STORAGE_KEY, sessionId);
  } catch {
    // 写不进去不影响本次会话
  }
}

/**
 * 把服务端存储的消息转成界面用的 {@link Message}。
 *
 * 服务端不存客户端的消息 id，这里按顺序生成稳定的本地 id；
 * 引用存的是 SSE 原样的 `{id,text,score}`，走同一套 normalizeReferences。
 */
function toRestoredMessages(stored: StoredSessionMessage[], sessionId: string): Message[] {
  return stored.map((m, index) => ({
    id: `restored_${sessionId}_${index}`,
    role: m.role,
    content: m.content,
    isStreaming: false,
    timestamp: Date.parse(m.createdAt) || Date.now(),
    references: m.references ? normalizeReferences(m.references) : undefined,
  }));
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
  const sessionIdRef = useRef<string>(loadOrCreateSessionId());

  /** 当前会话 id 的 state 投影 —— 列表高亮需要它触发渲染，ref 单独做不到。 */
  const [sessionId, setSessionId] = useState<string>(sessionIdRef.current);

  /**
   * 挂载时恢复上次的对话。
   *
   * 以前 `messages` 只存在内存里，刷新就全没了；服务端虽然存了历史，
   * 但客户端从不读、也没有持久化 sessionId，两边对不上。
   * 现在 sessionId 落 localStorage，消息正文由服务端按 id 返回。
   *
   * 恢复失败（网络错误 / 旧 id 已失效）时静默当作新会话 —— 历史拉不到
   * 不该阻止用户继续提问。
   */
  useEffect(() => {
    let cancelled = false;
    const sessionId = sessionIdRef.current;

    api
      .getSessionMessages(sessionId)
      .then(({ messages: stored }) => {
        if (cancelled || stored.length === 0) return;
        const restored = toRestoredMessages(stored, sessionId);
        // 如果用户在恢复完成前已经发了消息，不要覆盖当前对话
        setMessages((prev) => (prev.length > 0 ? prev : restored));
      })
      .catch(() => {
        /* 历史不可用：保持空会话 */
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
          // 后端给的是 {id, text, score}，这里归一化成卡片要的
          // {id, title, snippet, score}（见 utils/reference.ts）。
          onReferences: (references: unknown) => {
            const refs = normalizeReferences(references);
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
    // 持久化新 id：不然刷新后又会恢复回刚被清掉的那段对话
    persistSessionId(sessionIdRef.current);
    setSessionId(sessionIdRef.current);
  }, [disconnect]);

  /**
   * 切换到另一个历史会话。
   *
   * 和 `clearChat` 的区别：`clearChat` 是开一段全新的对话（id 轮换），
   * 这里是把当前会话**指向**一条已有的 session 并把它恢复出来。
   *
   * 切换前先断开 SSE：否则上一个会话的 token 会继续往新会话的消息列表里写。
   */
  const switchSession = useCallback(
    async (nextSessionId: string) => {
      if (nextSessionId === sessionIdRef.current) return;

      // 中止正在进行的生成，并清掉 token 批处理定时器（否则 50ms 后还会补一批进来）
      disconnect();
      if (tokenTimerRef.current) {
        clearTimeout(tokenTimerRef.current);
        tokenTimerRef.current = null;
      }
      tokenBatchRef.current = [];

      setMessages([]);
      setError(null);
      setIsStreaming(false);

      sessionIdRef.current = nextSessionId;
      persistSessionId(nextSessionId);
      setSessionId(nextSessionId);

      try {
        const { messages: stored } = await api.getSessionMessages(nextSessionId);
        const restored = toRestoredMessages(stored, nextSessionId);
        // 加载期间用户可能已经发了新消息，别拿历史把它覆盖掉
        setMessages((prev) => (prev.length > 0 ? prev : restored));
      } catch {
        /* 拉不到就停在新会话的空态，不影响继续提问 */
      }
    },
    [disconnect],
  );

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
    // Finalise the streaming message: keep whatever content arrived, clear the
    // streaming flag, and mark it as stopped so the bubble can say so instead
    // of silently looking like a finished (or blank) answer.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === streamingMsgIdRef.current ? { ...m, isStreaming: false, stopped: true } : m,
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
    sessionId,
    sendMessage,
    retryLast,
    clearChat,
    switchSession,
    stopGenerating,
    disconnect,
  };
}
