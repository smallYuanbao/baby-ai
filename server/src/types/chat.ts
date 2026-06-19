import { z } from 'zod';

/**
 * Chat Types & Validators
 * ========================
 *
 * This module is the **single source of truth** for every data structure that flows through
 * the chat subsystem.  It defines:
 *
 * 1. **Zod validation schemas** – used by Express middleware/controllers to validate and
 *    parse incoming HTTP request bodies before they reach any business logic.
 * 2. **Inferred TypeScript types** – derived from those schemas so that downstream code
 *    (route handlers, RAG pipeline, SSE emitter) can rely on compile-time guarantees.
 * 3. **Response / SSE-chunk interfaces** – the shape of every event that is sent back to
 *    the client over a Server-Sent Events (SSE) stream or as a one-shot JSON response.
 *
 * ## Role in the architecture
 *
 * ```
 * Client (browser)
 *   |
 *   | POST /api/chat  { message, history?, fileId? }
 *   v
 * Express route ── validates body with ChatRequestSchema (this file)
 *   |
 *   | ChatRequest (typed)
 *   v
 * RAG Pipeline
 *   ├─ 1. Query rewriting   ── rewrites user message for better retrieval
 *   ├─ 2. Searching         ── vector / keyword search over document store
 *   ├─ 3. Reranking         ── relevance scoring of candidate chunks
 *   └─ 4. Generating        ── LLM call with retrieved context + conversation history
 *   |
 *   | SSE chunks: StatusData, TokenData, ReferencesData, DoneData | ErrorData
 *   v
 * Client renders streaming response progressively.
 * ```
 *
 * Each pipeline stage emits a `StatusData` SSE chunk so the UI can display a progress
 * indicator ("Searching…", "Reranking…", "Generating…").  Retrieved references are sent
 * as `ReferencesData` chunks, generated tokens are streamed as `TokenData` chunks, and
 * the stream is terminated by either `DoneData` (success) or `ErrorData` (failure).
 *
 * ## SSE event contract
 *
 * The SSE stream uses named events.  The client listens for:
 *
 * | event name   | payload type     | semantics                            |
 * |-------------|------------------|--------------------------------------|
 * | `status`    | `StatusData`     | Pipeline stage transition             |
 * | `token`     | `TokenData`      | Single LLM-generated token            |
 * | `references`| `ReferencesData` | Retrieved document chunks             |
 * | `done`      | `DoneData`       | Terminal – stream completed normally  |
 * | `error`     | `ErrorData`      | Terminal – stream aborted with error  |
 *
 * @module chat/types
 */

/* ==================================================================
 *  Zod Validation Schemas
 *  ==================================================================
 */

/**
 * A single turn in the conversation history.
 *
 * Represents one message exchanged between the user and the assistant during
 * the current chat session.  The history array is passed with every request
 * so the LLM has full conversational context without the server needing to
 * persist session state.
 *
 * **Validation guarantees:**
 * - `role` is always `'user'` or `'assistant'` (rejects arbitrary strings at
 *   the boundary).
 * - `content` is never an empty string (avoids sending garbage to the LLM and
 *   wasting tokens).
 */
export const ChatHistoryEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

/**
 * Validated shape of a `POST /api/chat` request body.
 *
 * The Express layer uses this schema (via Zod's `.parse()`) **before** any
 * controller or pipeline code runs, so every downstream function receives a
 * fully-typed, guaranteed-valid `ChatRequest`.
 *
 * **Field semantics:**
 * - `message` – the user's current question / prompt.  Must be non-empty.
 * - `history` – prior conversation turns (oldest first).  Defaults to `[]`
 *   when omitted (first message in a session).
 * - `fileId` – optional identifier for a previously-uploaded file that the
 *   user wants to ask questions about.  When present the RAG pipeline may
 *   scope its search to that specific document.
 *
 * @example
 * ```ts
 * // Minimal valid request (first message)
 * { message: "What is RAG?" }
 *
 * // With conversation history
 * {
 *   message: "Can you elaborate?",
 *   history: [
 *     { role: "user", content: "What is RAG?" },
 *     { role: "assistant", content: "RAG stands for Retrieval-Augmented Generation..." }
 *   ]
 * }
 *
 * // Scoped to a specific uploaded file
 * { message: "Summarise this document", fileId: "abc-123" }
 * ```
 */
export const ChatRequestSchema = z.object({
  message: z.string().min(1, '消息不能为空'),
  history: z.array(ChatHistoryEntrySchema).optional().default([]),
  fileId: z.string().optional(),
});

/* ==================================================================
 *  Inferred TypeScript Types (from Zod schemas)
 *  ==================================================================
 */

/**
 * Inferred type for a single conversation turn.
 *
 * Derived from {@link ChatHistoryEntrySchema}.  Use this type everywhere in
 * the codebase instead of defining a separate interface to keep validation
 * and types in lockstep.
 */
export type ChatHistoryEntry = z.infer<typeof ChatHistoryEntrySchema>;

/**
 * Inferred type for the validated chat request.
 *
 * Derived from {@link ChatRequestSchema}.  Downstream functions (RAG pipeline
 * entry-point, SSE emitter setup) should accept this type so the compiler
 * enforces that only validated data reaches them.
 */
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/* ==================================================================
 *  Response / SSE Chunk Interfaces
 *  ==================================================================
 */

/**
 * A single retrieved document chunk that is surfaced to the user as a
 * citation or source reference.
 *
 * Produced by the **searching → reranking** stages of the RAG pipeline.
 * Each `Reference` corresponds to one chunk (a small slice of a document)
 * that the retriever deemed semantically relevant to the user's (possibly
 * rewritten) query.
 *
 * **Field semantics:**
 * - `id` – unique numeric identifier for this reference within the current
 *   response.  The generated answer text may include bracketed citation
 *   markers like `[1]`, `[2]` that map to these ids.
 * - `title` – human-readable title of the source document (e.g. filename,
 *   article heading).
 * - `snippet` – a short excerpt / surrounding context from the document
 *   chunk, typically trimmed to a fixed character length for display in the
 *   UI citation panel.
 * - `score` – relevance score in the range `[0, 1]` assigned by the reranker
 *   (higher = more relevant).  The array is sorted descending by score before
 *   being sent to the client.
 */
export interface Reference {
  /** Unique numeric citation id (1-based, matches `[n]` markers in generated text). */
  id: number;
  /** Source document title (filename, article heading, etc.). */
  title: string;
  /** Short excerpt from the retrieved chunk for inline display. */
  snippet: string;
  /** Reranker relevance score in [0, 1]; higher is more relevant. */
  score: number;
}

/**
 * Non-streaming (batch) response payload.
 *
 * Returned when the client does **not** request an SSE stream, or as the
 * summary object after a streaming session is aggregated.  Contains the
 * complete generated answer, its citations, and a token-usage summary.
 *
 * **NOTE:** In the streaming (SSE) path this exact shape is **not** sent as a
 * single event.  Instead the fields are delivered incrementally via
 * {@link TokenData}, {@link ReferencesData}, and {@link DoneData} chunks.
 */
export interface ChatResponse {
  /** Unique identifier for this message (generated server-side, used for feedback / tracing). */
  messageId: string;
  /** The full generated answer text (markdown). */
  content: string;
  /** Retrieved document chunks cited in the answer, sorted by relevance descending. */
  references: Reference[];
  /** Total LLM tokens consumed (prompt + completion) for this request. */
  totalTokens: number;
}

/**
 * SSE chunk carrying a **single generated token**.
 *
 * Emitted for every token produced by the LLM during the "generating" stage.
 * The client concatenates these tokens in order to reconstruct the full
 * answer text progressively, giving the user a typewriter-like experience.
 *
 * **Event name on the wire:** `"token"`
 *
 * **Input/output contract (RAG pipeline):**
 * - **Input:** raw token string from the LLM's streaming completion API
 *   (e.g. OpenAI / Anthropic streaming endpoint).
 * - **Output:** wrapped in an SSE `data:` line with event type `token`.
 * - **Contract:** tokens are emitted in strict generation order.  The client
 *   must concatenate them **without** inserting whitespace unless the token
 *   itself contains it.
 */
export interface TokenData {
  /** A single token string produced by the LLM (may be a word, sub-word, punctuation, or whitespace). */
  text: string;
}

/**
 * SSE chunk carrying the **full list of retrieved references**.
 *
 * Sent once per request, typically **before** token streaming begins (but
 * after searching + reranking complete), so the UI can render citation
 * markers and a sources panel in parallel with the streaming answer.
 *
 * **Event name on the wire:** `"references"`
 *
 * **Input/output contract (RAG pipeline):**
 * - **Input:** the ranked `Reference[]` produced by the reranker stage.
 * - **Output:** wrapped in an SSE `data:` line with event type `references`.
 * - **Contract:** this chunk is emitted exactly once (never zero, never
 *   multiple).  If no documents were retrieved the array is empty.
 */
export interface ReferencesData {
  /** Ranked list of document chunks to cite, sorted by relevance descending. */
  references: Reference[];
}

/**
 * Terminal SSE chunk signalling **successful completion** of the stream.
 *
 * Emitted after the final token has been sent and the LLM response is
 * finished.  The client uses this event to finalise the UI state (hide the
 * "loading" indicator, enable the input box, record the `messageId` for
 * feedback purposes).
 *
 * **Event name on the wire:** `"done"`
 *
 * **Input/output contract (RAG pipeline):**
 * - **Input:** final token count returned by the LLM provider's usage
 *   metadata (prompt_tokens + completion_tokens).
 * - **Output:** wrapped in an SSE `data:` line with event type `done`.
 * - **Contract:** this is **always** the last event on a successful stream.
 *   The client must treat `done` as a stream-closed signal and stop
 *   listening.
 */
export interface DoneData {
  /** Unique identifier for the completed message (matches {@link ChatResponse.messageId}). */
  messageId: string;
  /** Total tokens consumed (prompt + completion) for this request. */
  totalTokens: number;
}

/**
 * Terminal SSE chunk signalling an **error** that aborted the stream.
 *
 * Emitted when any stage of the RAG pipeline fails irrecoverably (LLM API
 * error, vector-store timeout, validation failure, etc.).  The client should
 * display the error message to the user and reset the chat UI to an
 * accepting-input state.
 *
 * **Event name on the wire:** `"error"`
 *
 * **Fallback / degradation note:** if the error occurs *after* token
 * streaming has started, the client should preserve any already-rendered
 * tokens so the user can see partial output.
 */
export interface ErrorData {
  /**
   * Machine-readable error code for programmatic handling.
   *
   * Example values: `"LLM_TIMEOUT"`, `"RATE_LIMITED"`, `"VECTOR_STORE_DOWN"`,
   * `"INVALID_REQUEST"`.
   */
  code: string;
  /** Human-readable error message suitable for display in the UI. */
  message: string;
}

/**
 * Pipeline stage transition event.
 *
 * The RAG pipeline emits a `StatusData` chunk whenever it moves from one
 * stage to the next.  The client renders a progress indicator (e.g. a
 * stepper, a spinner label) so the user understands what the system is doing
 * during potentially-latent periods.
 *
 * **Event name on the wire:** `"status"`
 *
 * ## RAG pipeline stage order
 *
 * ```
 * rewriting  ──>  searching  ──>  reranking  ──>  generating
 * ```
 *
 * Each stage is described below:
 *
 * | stage        | what happens                                          | typical latency |
 * |-------------|-------------------------------------------------------|-----------------|
 * | `rewriting` | The user's raw query is reformulated by a small/fast LLM to improve retrieval precision. | ~200-500 ms |
 * | `searching` | The (rewritten) query is embedded and used to search the vector store for candidate chunks.  Keyword / hybrid search may also run in parallel. | ~100-300 ms |
 * | `reranking` | Candidate chunks are scored by a cross-encoder reranker model.  Low-scoring chunks are dropped; the remainder are sorted descending. | ~200-800 ms (depends on candidate count) |
 * | `generating`| The LLM is called with the retrieved context + conversation history to produce the final answer.  Tokens are streamed via {@link TokenData} chunks. | ~1-30 s (depends on answer length) |
 *
 * **Contract:** each stage is emitted **at most once** per request, and they
 * are always emitted in the order listed above.  If a stage fails, the
 * pipeline short-circuits to an {@link ErrorData} event instead of
 * continuing.
 */
export interface StatusData {
  /** Current pipeline stage.  The UI maps each value to a localised label. */
  stage: 'rewriting' | 'searching' | 'reranking' | 'generating';
}
