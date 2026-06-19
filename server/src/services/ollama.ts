/**
 * @file ollama.ts — Ollama Embedding Service
 *
 * ## Responsibility
 *
 * This service abstracts all communication with a locally-running Ollama
 * instance for the sole purpose of generating text embedding vectors. It is
 * the single entry point for converting natural-language text into dense
 * vector representations consumed by the RAG (Retrieval-Augmented Generation)
 * pipeline.
 *
 * ## Role in the Architecture
 *
 * ```
 *   UI / API Layer
 *        │
 *   ┌────▼──────────────────────────────────────────┐
 *   │  RAG Pipeline (retrieval + answer generation)  │
 *   │    │                                           │
 *   │    ├── query vectorisation  ──► ollama.ts      │  ◄── this file
 *   │    ├── chunk indexing        ◄──                │
 *   │    └── vector similarity search                 │
 *   └────────────────────────────────────────────────┘
 *        │
 *   Ollama Server (default: http://127.0.0.1:11434)
 * ```
 *
 * Callers use this service to:
 *   - Convert a user query into an embedding for similarity search against a
 *     vector store (Chroma, HNSW index, or in-memory store).
 *   - Convert document chunks into embeddings during ingestion / indexing.
 *
 * ## Key Design Decisions
 *
 *   - **Single-responsibility**: this module only deals with the HTTP wire
 *     format and error translation. Embedding caching, batching strategy, and
 *     index writes live in their own services.
 *   - **No retry / circuit breaker** at this layer. Callers are expected to
 *     handle transient failures or wrap calls in a retry utility. We surface
 *     actionable errors (e.g. "Ollama not running") rather than swallowing
 *     them.
 *   - **AbortController timing** is per-request with a hard 20 s ceiling so
 *     hung calls never starve the Node.js event loop.
 *   - **Stateless**: every call is self-contained — no persistent connections
 *     and no in-flight request pool.
 *   - **Sequential batch processing** in `getEmbeddings()` — intentional for
 *     ordering guarantees and simplicity given typical small-batch workloads.
 *
 * ## Configuration
 *
 * All URL and model parameters are read from the central `config` object
 * (`config.ollama.baseUrl`, `config.ollama.embedModel`). See `src/config/`.
 *
 * @module services/ollama
 */

import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Full endpoint URL for the Ollama `/api/embeddings` route.
 *
 * Constructed from the base URL in the application config. The Ollama REST API
 * embedding endpoint accepts POST requests with JSON body:
 *
 *   { model: "<model_name>", prompt: "<text>" }
 *
 * and returns:
 *
 *   { embedding: [0.123, -0.456, ...] }
 */
const OLLAMA_EMBED_URL = `${config.ollama.baseUrl}/api/embeddings`;

/**
 * Per-request timeout in milliseconds (20 seconds).
 *
 * This value is deliberately generous because Ollama loads models lazily on
 * the first request — a cold start can legitimately take 10–15 seconds. After
 * the model is warm, requests typically complete in under 1 second.
 */
const TIMEOUT_MS = 20000; // 20 秒超时

// ---------------------------------------------------------------------------
// Exported service functions
// ---------------------------------------------------------------------------

/**
 * Compute a single embedding vector for the given input text.
 *
 * ## RAG Pipeline Contract — Input / Output
 *
 *   Input  — `text` (string): raw, untruncated text. This may be a user
 *            question ("什么是 RAG？"), a document chunk, or any other
 *            natural-language snippet. Truncation (if needed) is the caller's
 *            responsibility.
 *
 *   Output — `number[]`: a dense floating-point embedding vector whose
 *            dimensionality depends on the configured model (e.g. 1024 for
 *            `bge-m3`). The vector is NOT normalised by this function;
 *            callers that need cosine similarity must normalise post-hoc.
 *
 * ## Algorithm / Flow
 *
 *   1. Create an `AbortController` and arm a 20 s timeout via `setTimeout`.
 *   2. POST to `OLLAMA_EMBED_URL` with JSON body `{ model, prompt }`.
 *   3. On HTTP 2xx: parse the JSON response as `{ embedding: number[] }` and
 *      return the `.embedding` array.
 *   4. On HTTP non-2xx: read the error response body as text, construct an
 *      error message including the status code and body, and throw.
 *   5. On network / timeout errors: translate known failure modes
 *      (`AbortError`, `ECONNREFUSED`) into user-actionable messages; log and
 *      re-throw unknown errors.
 *   6. In the `finally` block: clear the timeout to prevent a leaked timer
 *      handle.
 *
 * ## Error Handling (Degradation / Fallback)
 *
 *   | Failure               | Behaviour                                            |
 *   |-----------------------|------------------------------------------------------|
 *   | Timeout (> 20 s)      | `AbortError` caught → user-facing `Error` thrown     |
 *   | Connection refused    | `ECONNREFUSED` caught → user-facing `Error` thrown   |
 *   | HTTP 4xx / 5xx        | Response body logged via the catch handler;          |
 *   |                       |   descriptive `Error` thrown                         |
 *   | Unknown / network     | Logged and re-thrown (bubbles to the caller)          |
 *
 *   This service does **not** implement retry logic. Transient errors must be
 *   handled by the calling context (e.g. a request handler with exponential
 *   backoff).
 *
 * @param text  - The raw text to embed. Must be non-empty; an empty string
 *                will produce a valid but semantically meaningless embedding.
 * @returns A promise that resolves to the embedding vector as `number[]`.
 * @throws {Error} With a Chinese-language actionable message if Ollama is
 *                 unreachable, the model is missing, or the request times out.
 * @throws {Error} Re-throws any unrecognised network or parse error.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  // --- Setup: create abort controller and arm timeout ---
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // --- Execute POST to Ollama /api/embeddings ---
    const response = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.ollama.embedModel, prompt: text }),
      signal: controller.signal,
    });

    // --- Handle non-OK HTTP status (model missing, server error, etc.) ---
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama embedding 失败 (${response.status}): ${errorText}`);
    }

    // --- Parse the successful JSON response ---
    // Ollama returns: { "embedding": [0.123, -0.456, ...] }
    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  } catch (err: any) {
    // --- Translate known low-level failure modes into actionable errors ---

    // 1. Client-side timeout: AbortController fired before Ollama responded.
    if (err.name === 'AbortError') {
      logger.error('Ollama embedding 请求超时');
      throw new Error('Ollama 服务无响应，请确认 Ollama 已启动并已拉取 bge-m3 模型');
    }

    // 2. OS-level TCP connection refused: Ollama process is not running.
    if (err.code === 'ECONNREFUSED') {
      throw new Error('无法连接 Ollama 服务，请确认 Ollama 已启动 (http://127.0.0.1:11434)');
    }

    // 3. Unknown error (network reset, DNS failure, JSON parse error, etc.).
    //    Log the message for debugging and re-throw to the caller.
    logger.error('Ollama embedding 请求失败:', err.message);
    throw err;
  } finally {
    // --- Cleanup: always disarm the timeout to prevent a leaked timer ---
    clearTimeout(timeout);
  }
}

/**
 * Batch-compute embeddings for an array of texts.
 *
 * ## RAG Pipeline Contract — Input / Output
 *
 *   Input  — `texts` (string[]): ordered list of raw texts (queries, document
 *            chunks, or any mixture). Length is unbounded, but callers should
 *            be aware that each text triggers a separate HTTP round-trip.
 *
 *   Output — `number[][]`: ordered list of embedding vectors, one per input
 *            text. `embeddings[i]` corresponds to `texts[i]`.
 *
 * ## Algorithm
 *
 *   This is a **sequential** (non-concurrent) implementation that iterates
 *   over the input array and calls `getEmbedding()` once per element. It is
 *   intentionally kept simple:
 *
 *     - Ordering is guaranteed — positional correspondence between input
 *       `texts[i]` and output `embeddings[i]` is preserved.
 *     - No concurrency cap is needed for the typical small-batch use case
 *       (a handful of chunks or a single query).
 *
 *   If batch sizes grow beyond ~20 items, a future optimisation could:
 *     - Add a concurrency limiter (e.g. `p-limit` with `concurrency: 4`).
 *     - Investigate whether the targeted Ollama version exposes a true batch
 *       `/api/embeddings` endpoint that accepts an array of prompts in a
 *       single HTTP call (reducing per-request TLS/HTTP overhead).
 *
 * ## Error Handling
 *
 *   The function **aborts early** on the first failure. If `getEmbedding`
 *   throws for text `i`, texts `i+1...n` are not processed and the error is
 *   propagated to the caller. Partial results are **not** returned.
 *
 *   For production use cases that cannot tolerate losing all progress on the
 *   last item, consider a per-item try/catch that collects errors in a
 *   parallel array alongside successful results.
 *
 * @param texts  - Non-empty array of texts to embed. An empty array produces
 *                 `[]` with no network calls made.
 * @returns A promise that resolves to an ordered array of embedding vectors.
 * @throws {Error} Re-throws any error from the underlying `getEmbedding`
 *                 calls — see its documentation for possible causes.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  // Process each text sequentially — see function JSDoc for the rationale
  // behind sequential processing and optimisation notes for larger batches.
  for (const text of texts) {
    const emb = await getEmbedding(text);
    embeddings.push(emb);
  }

  return embeddings;
}

/**
 * Default export: the public surface of the ollama service.
 *
 * Consumers should prefer the named imports (`getEmbedding`, `getEmbeddings`)
 * for tree-shaking and clarity. The default export is provided for convenience
 * when importing the service as a single namespace object.
 */
export default { getEmbedding, getEmbeddings };
