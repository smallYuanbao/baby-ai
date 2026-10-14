/**
 * @file chat.ts
 * @description Type definitions for the chat feature of the baby-ai client.
 *
 * This file defines the core data structures used throughout the chat system,
 * including messages, sessions, references (RAG citations), SSE streaming events,
 * and the request/response contracts for the chat API. All interfaces are
 * intentionally flat and serializable so they can pass cleanly over HTTP and be
 * stored in client-side persistence (e.g. localStorage / IndexedDB).
 */

/**
 * A single chat message — either from the user or from the AI assistant.
 *
 * @description Represents one turn in a conversation. The `isStreaming` flag
 *              allows the UI to render progressively while the server sends
 *              tokens via SSE, and the optional `error` field captures failures
 *              for inline display. File context (when the user uploads a
 *              document) is tracked via `fileId` / `fileName`.
 */
export interface Message {
  /** Unique identifier for this message (client-generated UUID). */
  id: string;

  /** Who sent the message: the end-user or the AI assistant. */
  role: 'user' | 'assistant';

  /** The textual body of the message (markdown rendered by the frontend). */
  content: string;

  /**
   * Optional list of knowledge-base references attached to an assistant
   * response (RAG citations). Only present on assistant messages after
   * the full response has been received.
   */
  references?: Reference[];

  /**
   * Whether the assistant response is still being streamed from the server.
   * The UI uses this flag to show a blinking cursor / skeleton while `true`.
   */
  isStreaming: boolean;

  /**
   * 这条回答是被用户「停止生成」中断的（而非正常答完）。
   *
   * 存在的意义是区分「答完了」和「答到一半被掐断」——后者在育儿/医疗这类
   * 场景里必须显式告诉用户，否则一段被截断的建议看起来像完整结论。
   * 停止时一个字都没收到的情况下，也靠它避免渲染出一个空白气泡。
   */
  stopped?: boolean;

  /** Unix-epoch millisecond timestamp of when the message was created. */
  timestamp: number;

  /** ID of an uploaded file the user attached to this message (optional). */
  fileId?: string;

  /** Original filename for display purposes (optional). */
  fileName?: string;

  /**
   * If the message could not be processed, this field carries a human-readable
   * error description. The UI renders it as an inline error banner.
   */
  error?: string;
}

/**
 * A persisted chat session containing the full message history.
 *
 * @description Sessions are the top-level container for conversations. Each
 *              session is identified by a server-assigned `sessionId` and
 *              tracks both creation and last-update timestamps so the sidebar
 *              can sort by recency.
 */
export interface ChatSession {
  /** Server-assigned unique identifier for this conversation. */
  sessionId: string;

  /** Ordered list of all messages in this session (earliest first). */
  messages: Message[];

  /** Unix-epoch millisecond timestamp of when the session was created. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of the most recent message or edit. */
  updatedAt: number;
}

/**
 * A knowledge-base reference (RAG citation) returned with an assistant answer.
 *
 * @description 这是**给界面用的视图模型**，不是接口原样返回的形状 ——
 *              后端只给 `{id, text, score}`，标题和摘要要从 `text` 里拆出来。
 *              转换发生在 `utils/reference.ts` 的 `normalizeReferences`。
 */
export interface Reference {
  /** 知识库分块 ID（如 `med_32ce4015`）；只用作 React key，不直接展示。 */
  id: string;

  /** Title of the source document. */
  title: string;

  /** A short excerpt from the document that supports the answer. */
  snippet: string;

  /**
   * 相关性分数，0（不相关）~ 1（完全匹配）。
   * 由精排阶段给出；精排缺席时（如工具调用产生的合成引用）为 `undefined`，
   * 此时界面不显示分数徽章，而不是显示一个假的 0。
   */
  score?: number;
}

/**
 * A Server-Sent Events (SSE) envelope received during streaming.
 *
 * @description The backend pushes SSE events to the client while generating a
 *              response. Each event has a string `event` type (e.g. "token",
 *              "done", "error") and a `data` payload whose shape depends on
 *              the event type.
 */
export interface SSEEvent {
  /** Event type discriminator (e.g. "token", "done", "error"). */
  event: string;

  /** Payload for the event — shape varies by `event` type. */
  data: unknown;
}

/**
 * Request body sent to the chat API endpoint.
 *
 * @description The client POSTs this structure to initiate or continue a
 *              conversation. The optional `history` field allows stateless
 *              requests (the server reconstructs context from the array), and
 *              `fileId` references a previously uploaded document.
 */
export interface ChatRequest {
  /** The user's latest message text. */
  message: string;

  /**
   * Optional full conversation history sent for stateless chat completions.
   * Each entry mirrors the `role`/`content` shape the LLM API expects.
   */
  history?: { role: 'user' | 'assistant'; content: string }[];

  /** Optional ID of a file the user uploaded for context. */
  fileId?: string;
}

/**
 * Response body returned by the chat API endpoint after a complete reply.
 *
 * @description When the streaming phase finishes, the server sends (or the
 *              client synthesizes) this summary object. It includes the
 *              generated `messageId`, the full `content`, any RAG `references`,
 *              and a `totalTokens` count for usage tracking.
 */
export interface ChatResponse {
  /** Server-assigned unique ID for this specific assistant message. */
  messageId: string;

  /** The full markdown content of the assistant's answer. */
  content: string;

  /** Knowledge-base references (citations) backing the answer. */
  references: Reference[];

  /** Total LLM tokens consumed for this request (prompt + completion). */
  totalTokens: number;
}
