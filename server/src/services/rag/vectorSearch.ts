/**
 * @file vectorSearch.ts — RAG Pipeline: Vector Search Stage (召回阶段叶子节点)
 *
 * ## Responsibility
 *
 * This module implements the **vector search stage** of the RAG
 * (Retrieval-Augmented Generation) pipeline. It is the "leaf" function
 * that orchestrates a single end-to-end retrieval flow:
 *
 *   raw query text → embedding vector → ChromaDB ANN search → ranked documents
 *
 * Conceptually, it is a thin **facade** that composes two lower-level services:
 *
 *   1. {@link ../ollama.ts}  — `getEmbedding()`: text → dense vector
 *   2. {@link ../chroma.ts}  — `searchByEmbedding()`: vector → top-K documents
 *
 * ### Role in the Architecture
 *
 * ```
 *                        RAG Pipeline
 *   ┌───────────┐    ┌──────────────┐    ┌──────────────┐    ┌────────────┐
 *   │  Query    │───►│  Rewriter    │───►│  [THIS FILE] │───►│  Reranker  │
 *   │  Entry    │    │  (rewrite.ts)│    │ vectorSearch │    │ (rerank.ts)│
 *   └───────────┘    └──────────────┘    └──────────────┘    └────────────┘
 *                                               │
 *                                        ┌──────┴──────┐
 *                                        │             │
 *                                   ollama.ts    chroma.ts
 *                                  (embedding)   (ANN search)
 * ```
 *
 * **Input contract**: Receives a **rewritten** query string from the upstream
 * rewriter stage. The rewriter has already resolved anaphora, expanded
 * abbreviations, and injected domain synonyms. This module does NOT perform
 * any text transformation — it trusts the upstream to deliver a
 * retrieval-optimised query.
 *
 * **Output contract**: Returns a flat, distance-sorted `RAGDocument[]` array
 * of length ≤ topK. These documents are the **candidate pool** for the
 * downstream Reranker stage, which re-scores them with a cross-encoder model.
 *
 * ## Key Design Decisions
 *
 *   - **Stateless**: Every call is self-contained. No caching, no session
 *     affinity, no in-flight request deduplication. If the same query arrives
 *     twice, both calls execute independently.
 *   - **Thin orchestration**: This file contains no embedding logic and no
 *     vector-search logic. It delegates entirely to `ollama.ts` and
 *     `chroma.ts`, keeping the RAG pipeline stages loosely coupled and
 *     independently testable.
 *   - **Default topK from config**: `config.rag.vectorSearchTopK` (env
 *     `VECTOR_SEARCH_TOP_K`, default 10) controls how many documents are
 *     recalled. Callers may override this per-request.
 *   - **No error swallowing**: Unlike `searchCollection()` in `chroma.ts`
 *     (which gracefully degrades per-collection), this function lets errors
 *     from both `getEmbedding()` and `searchByEmbedding()` propagate upward.
 *     The caller (typically a request handler) is responsible for error
 *     handling, logging, and user-facing messaging.
 *
 * ## Configuration Dependency
 *
 *   - `config.rag.vectorSearchTopK` — default recall count (env `VECTOR_SEARCH_TOP_K`)
 *   - `config.ollama.baseUrl` / `config.ollama.embedModel` — used indirectly
 *     via `getEmbedding()`
 *   - `config.chroma.url` / `config.chroma.searchCollections` — used
 *     indirectly via `searchByEmbedding()`
 *
 * ## Error Propagation
 *
 *   | Stage              | Failure Mode                     | Behaviour                         |
 *   |--------------------|----------------------------------|-----------------------------------|
 *   | `getEmbedding()`   | Ollama unreachable / timeout     | Error thrown with actionable message |
 *   | `getEmbedding()`   | Model not pulled                 | Error thrown with status + body   |
 *   | `searchByEmbedding()` | All collections fail          | Returns `[]` (graceful degradation) |
 *   | `searchByEmbedding()` | ChromaDB connection lost       | Returns partial results or `[]`   |
 *
 * @module services/rag/vectorSearch
 */

import { getEmbedding } from '../ollama.js';
import { searchByEmbedding } from '../chroma.js';
import type { RAGDocument } from '../../types/rag.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * Execute a complete vector search: query text → embedding → ChromaDB ANN retrieval.
 *
 * ## RAG Pipeline Contract — Input / Output
 *
 * ```
 *   Input ── query (string): rewritten, retrieval-optimised query text.
 *            This is the output of the rewriter stage (rewrite.ts).
 *            It has already been de-anaphora'd, expanded with synonyms,
 *            and formatted for maximum embedding quality.
 *
 *            topK (number, optional): how many documents to recall.
 *            Defaults to `config.rag.vectorSearchTopK` (env VECTOR_SEARCH_TOP_K,
 *            fallback 10). Callers that need fewer or more candidates
 *            (e.g. a "quick search" vs "deep research" mode) should
 *            override this parameter.
 *
 *   Output ── RAGDocument[]: distance-sorted candidate documents
 *            (length ≤ topK). Each document carries:
 *              - `id`        — unique document identifier
 *              - `text`      — original document text
 *              - `metadata`  — includes `_collection` (source collection name)
 *              - `distance`  — cosine distance (lower = more similar)
 *              - `score`     — undefined at this stage (populated by Reranker)
 *
 *            The array is the **candidate pool** for the downstream Reranker
 *            stage. It is sorted by cosine distance ascending, so index 0
 *            is the most similar document found.
 * ```
 *
 * ## Algorithm / Flow
 *
 *   ```
 *   Step 1 ─ getEmbedding(query)
 *            POST to Ollama /api/embeddings with { model, prompt: query }.
 *            Returns a dense float vector (e.g. 1024-dim for bge-m3).
 *            Timeout: 20 s. Errors surface as thrown Error objects.
 *
 *   Step 2 ─ searchByEmbedding(embedding, topK)
 *            Queries all configured ChromaDB collections in parallel
 *            (Promise.all). Each collection returns up to ceil(topK / N)
 *            documents. Results are merged, sorted by cosine distance,
 *            and truncated to topK. Individual collection failures are
 *            silently degraded (return []).
 *
 *   Step 3 ─ Return RAGDocument[] to caller.
 * ```
 *
 * ## Error Handling / Degradation
 *
 *   This function does **not** catch errors. All failures propagate upward:
 *
 *   - **Ollama failures** (timeout, ECONNREFUSED, HTTP 4xx/5xx):
 *     `getEmbedding()` throws an `Error` with a Chinese-language actionable
 *     message. The caller should surface this to the user or fall back to
 *     a non-RAG answer mode.
 *
 *   - **ChromaDB failures** (connection lost, corrupt collection):
 *     `searchByEmbedding()` internally degrades per-collection (empty array
 *     for failed collections) and only returns an empty `[]` if ALL
 *     collections fail. This is NOT an exception — the caller receives an
 *     empty array and should decide whether to proceed with a "no documents
 *     found" response or fall back to a base-LLM answer.
 *
 *   - **Combined failure**: If both stages fail (e.g. Ollama is down),
 *     the `getEmbedding()` error is thrown first and `searchByEmbedding()`
 *     is never reached.
 *
 * ## Usage Example
 *
 * ```typescript
 * import { vectorSearch } from './services/rag/vectorSearch.js';
 *
 * // Inside a request handler (after query rewriting):
 * const candidates = await vectorSearch(rewrittenQuery, 15);
 * if (candidates.length === 0) {
 *   // Fallback: answer without RAG context
 *   return baseLLMResponse(userQuery);
 * }
 * // Proceed to reranking
 * const reranked = await rerank(rewrittenQuery, candidates);
 * ```
 *
 * @param query - Rewritten query text from the upstream rewriter stage.
 *                Must be a non-empty string. An empty string will produce
 *                a valid but semantically meaningless embedding, leading to
 *                poor retrieval results.
 * @param topK  - Number of candidate documents to recall. Defaults to
 *                `config.rag.vectorSearchTopK` (env `VECTOR_SEARCH_TOP_K`,
 *                fallback 10). Higher values increase recall but also
 *                increase downstream reranking cost.
 * @returns A promise resolving to a distance-sorted array of `RAGDocument`
 *          objects (length ≤ topK). The array is sorted by `distance`
 *          ascending (most similar first). Returns `[]` if all ChromaDB
 *          collections fail or contain no matching documents.
 * @throws {Error} If Ollama is unreachable, the embedding model is not
 *                 pulled, or the HTTP request to Ollama times out (20 s).
 *                 Error messages are in Chinese and are suitable for
 *                 display to end users after appropriate sanitisation.
 */
export async function vectorSearch(
  query: string,
  topK: number = config.rag.vectorSearchTopK,
): Promise<RAGDocument[]> {
  // Log the query prefix for tracing — full query may contain PII
  logger.debug(`向量检索: "${query.slice(0, 50)}..."`);

  // -----------------------------------------------------------------------
  // Step 1: Query → Embedding (ollama.ts)
  //
  // Convert the rewritten query text into a dense embedding vector.
  // This is a synchronous-looking await: the call blocks until Ollama
  // responds or times out (20 s). On failure, an Error is thrown and
  // propagated to the caller — no fallback embedding source exists.
  // -----------------------------------------------------------------------
  const embedding = await getEmbedding(query);

  // -----------------------------------------------------------------------
  // Step 2: Embedding → Top-K Documents (chroma.ts)
  //
  // Search all configured ChromaDB collections in parallel for the
  // topK most similar documents. The underlying `searchByEmbedding()`
  // handles:
  //   - Per-collection quota allocation (ceil(topK / numCollections))
  //   - Parallel collection queries via Promise.all
  //   - Result merging, distance sorting, and topK truncation
  //   - Graceful degradation: a failed collection returns [] rather
  //     than throwing
  //
  // If all collections are empty or all queries fail, this returns [].
  // -----------------------------------------------------------------------
  const documents = await searchByEmbedding(embedding, topK);

  // Log the retrieval count for observability — helps diagnose
  // "no results" issues and tuning of the topK parameter
  logger.debug(`向量检索结果: ${documents.length} 条文档`);

  // -----------------------------------------------------------------------
  // Step 3: Return candidate pool to caller
  //
  // The caller (typically the RAG orchestrator or request handler) will
  // pass these documents to the Reranker stage for cross-encoder scoring,
  // or directly to the LLM for answer generation if reranking is disabled.
  // -----------------------------------------------------------------------
  return documents;
}
