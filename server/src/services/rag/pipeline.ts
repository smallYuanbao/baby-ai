/**
 * RAG Pipeline Orchestrator
 *
 * @fileoverview
 * This module is the central orchestrator for the Retrieval-Augmented Generation (RAG)
 * system. It chains together four discrete pipeline stages — Query Rewrite, Vector
 * Search, Rerank, and Context Building — into a single callable function that
 * transforms a raw user message (potentially carrying conversational context) into a
 * structured result containing the rewritten query, the assembled LLM context, ranked
 * documents, and formatted references.
 *
 * ## Architectural role
 *
 * The pipeline sits between the chat route handler and the LLM generation layer.
 * When a user message arrives:
 *
 *    Chat route  →  runRAGPipeline()  →  LLM generation (with injected context)
 *                      │
 *                      ├── Step 1: queryRewriter.rewriteQuery()
 *                      ├── Step 2: vectorSearch()
 *                      ├── Step 3: reranker.rerank()
 *                      └── Step 4: contextBuilder.buildContext()
 *
 * Each step is an independent module with a well-defined input/output contract.
 * The orchestrator's responsibilities are limited to:
 *   - Sequencing the calls in the correct order.
 *   - Translating errors from individual steps into pipeline-level errors (for
 *     unrecoverable stages) or logging a warning and falling back to a degradation
 *     path (for best-effort stages).
 *   - Assembling the final {@link RAGPipelineResult} so callers receive a single,
 *     self-describing package.
 *
 * ## Degradation / fallback strategy
 *
 * | Stage          | Failure behaviour                                      |
 * |----------------|--------------------------------------------------------|
 * | Query Rewrite  | **Fatal.** Throws `Error('查询改写失败: ...')`.        |
 * | Vector Search  | **Fatal.** Throws `Error('向量检索失败: ...')`.        |
 * | Rerank         | **Non-fatal.** Logs warning, continues with raw search |
 * |                 | results (distance-ordered).                             |
 * | Context Builder| Synchronous; cannot fail in a recoverable way.          |
 *
 * The rationale: Query Rewrite and Vector Search are hard dependencies — without them
 * there is no meaningful retrieval. Rerank is a quality-of-life improvement; the
 * pipeline degrades gracefully to distance-based ordering when the reranker is
 * unavailable, timed out, or throws.
 *
 * ## Environment / configuration (read from {@link config})
 *
 * | Key                      | Env var                    | Default | Purpose                        |
 * |--------------------------|----------------------------|---------|--------------------------------|
 * | rag.queryRewriteEnabled  | QUERY_REWRITE_ENABLED      | true    | Enable Step 1                  |
 * | rag.vectorSearchTopK     | VECTOR_SEARCH_TOP_K        | 10      | Number of candidates to recall |
 * | rag.rerankTopK           | RERANK_TOP_K               | 4       | Number of documents after rank |
 * | rag.rerankerUrl          | RERANKER_URL               | ''      | BGE Reranker service endpoint  |
 *
 * @module services/rag/pipeline
 */

import type { ChatHistoryEntry, Reference } from '../../types/chat.js';
import type { RAGDocument } from '../../types/rag.js';
import { rewriteQuery } from './queryRewriter.js';
import { vectorSearch } from './vectorSearch.js';
import { rerank } from './reranker.js';
import { buildContext } from './contextBuilder.js';
import logger from '../../utils/logger.js';

/**
 * The complete result of a RAG pipeline execution.
 *
 * Callers (typically the chat route handler) use this to:
 *   - Know whether the query was rewritten (useful for logging / debugging / SSE
 *     status events).
 *   - Pass `context` directly into the LLM system prompt.
 *   - Return `references` to the frontend so it can render citation footnotes.
 *   - Inspect `documents` for observability (e.g. tracing which chunks were used).
 */
export interface RAGPipelineResult {
  /** The original, unmodified user message as received. */
  query: string;

  /** The query after optional pronoun-resolution / coreference rewriting.
   *  Equal to `query` when rewriting was disabled or not triggered. */
  rewrittenQuery: string;

  /** `true` when Step 1 (Query Rewrite) modified the query; `false` otherwise. */
  wasRewritten: boolean;

  /** The final context string injected into the LLM system prompt.
   *  Contains citation markers like `[1]`, `[2]` that the LLM is instructed to
   *  use when composing its answer. */
  context: string;

  /** Formatted references for the frontend — one per document fed into the context.
   *  Each entry carries an id, title, snippet, and relevance score. */
  references: Reference[];

  /** The ranked document list after Step 3 (Rerank). This is the authoritative
   *  set of documents that `context` and `references` are derived from. */
  documents: RAGDocument[];
}

/**
 * Execute the full RAG pipeline end-to-end.
 *
 * ## Pipeline stages (in order)
 *
 * ### Step 1 — Query Rewrite (`queryRewriter.rewriteQuery`)
 *
 * **Condition:** Only triggered when ALL of the following are true:
 *   1. `config.rag.queryRewriteEnabled` is `true`.
 *   2. `history` is non-empty.
 *   3. The message contains a Chinese pronoun / demonstrative (他, 她, 它, 这个,
 *      那些, etc.).
 *
 * **What it does:** Sends a prompt to DeepSeek asking it to resolve coreferences
 * against the provided conversation history, producing a self-contained query.
 * For example, `"它安全吗？"` with history about `"React"` becomes `"React 安全吗？"`.
 *
 * **Input contract:**
 *   - `message: string` — raw user message.
 *   - `history: ChatHistoryEntry[]` — up to 8 recent conversation turns.
 *
 * **Output contract:**
 *   - `{ originalQuery, rewrittenQuery, wasRewritten }` (see {@link RewriteResult}).
 *
 * **Error handling:** **Fatal.** If DeepSeek returns an error the pipeline aborts
 *   immediately with `Error('查询改写失败: ...')`.
 *
 * ---
 *
 * ### Step 2 — Vector Search (`vectorSearch`)
 *
 * **What it does:**
 *   1. Calls `ollama.getEmbedding()` (model `bge-m3`) to convert the rewritten
 *      query text into a dense embedding vector.
 *   2. Sends the embedding to ChromaDB's `searchByEmbedding()` which performs
 *      cosine-similarity search over the pre-ingested document collection.
 *   3. Returns the top-`config.rag.vectorSearchTopK` (default 10) most similar
 *      chunks as {@link RAGDocument} objects.
 *
 * **Input contract:**
 *   - `query: string` — the rewritten query from Step 1.
 *   - `topK: number` (optional, default from config) — how many candidates to recall.
 *
 * **Output contract:**
 *   - `RAGDocument[]` — unordered list of candidate documents, each carrying an
 *     `id`, `text`, `metadata`, and Chroma `distance`.
 *
 * **Error handling:** **Fatal.** If Ollama or ChromaDB are unreachable the pipeline
 *   aborts with `Error('向量检索失败: ...')`.
 *
 * ---
 *
 * ### Step 3 — Rerank (`reranker.rerank`)
 *
 * **Condition:** Only meaningful when `searchResults.length > 0` AND
 *   `searchResults.length > config.rag.rerankTopK` (default 4). When the candidate
 *   count is already <= topK, the reranker is skipped entirely and the search
 *   results are passed through with distance-derived scores.
 *
 * **What it does (two-tier fallback):**
 *   1. **Primary path — BGE Reranker service** (`callBGEReranker`):
 *      Sends `{ query, documents }` to the FastAPI endpoint at
 *      `config.rag.rerankerUrl`. Uses a 60-second timeout via `AbortController`.
 *      Maps the returned `{ id, score }` pairs back onto the original documents
 *      and sorts descending by relevance score.
 *
 *   2. **Fallback path — DeepSeek LLM** (`rerankWithDeepSeek`):
 *      Triggered when the BGE Reranker URL is not configured, the HTTP call fails,
 *      or the request times out. Sends a prompt asking DeepSeek to rank documents
 *      by relevance, parses the returned indices, and assigns synthetic scores.
 *
 *   3. **Last-resort fallback:**
 *      If DeepSeek also fails (network error, malformed response), the top-K
 *      documents are taken from the original search results in distance order.
 *
 * **Input contract:**
 *   - `query: string` — the rewritten query from Step 1.
 *   - `documents: RAGDocument[]` — candidate documents from Step 2.
 *   - `topK: number` (optional, default from config) — how many to retain.
 *
 * **Output contract:**
 *   - `{ query, rankedDocuments }` (see {@link RerankResult}) — documents sorted
 *     by relevance score descending, length <= topK.
 *
 * **Error handling:** **Non-fatal.** The pipeline never aborts on rerank failure.
 *   Warnings are logged and the pipeline proceeds with the best available results
 *   (original search order or DeepSeek-ranked if that succeeded).
 *
 * ---
 *
 * ### Step 4 — Context Builder (`contextBuilder.buildContext`)
 *
 * **What it does:** Transforms the ranked document list into two parallel outputs:
 *   - A `context` string: a prompt fragment that lists each document with a
 *     citation marker (`[1]`, `[2]`, …) and instructs the LLM to use those
 *     markers in its response.
 *   - A `references` array: structured metadata (`id`, `title`, `snippet`, `score`)
 *     for each document, suitable for rendering citation footnotes in the frontend.
 *
 * **Input contract:**
 *   - `documents: RAGDocument[]` — the ranked documents from Step 3.
 *
 * **Output contract:**
 *   - `{ context: string, references: Reference[] }`
 *
 * **Error handling:** Synchronous function. No runtime errors expected beyond
 *   malformed input (e.g. missing `text` field), which would surface as an
 *   uncaught exception — the pipeline does not add a try/catch around this step.
 *
 * ---
 *
 * ## Return value
 *
 * The assembled {@link RAGPipelineResult} containing the original query, the
 * (possibly) rewritten query, a flag indicating whether rewriting occurred, the
 * final context string, the formatted references, and the ranked document list.
 *
 * ## Error contract
 *
 * | Condition                          | Error thrown                              |
 * |------------------------------------|-------------------------------------------|
 * | `rewriteQuery()` rejects           | `Error('查询改写失败: <reason>')`         |
 * | `vectorSearch()` rejects           | `Error('向量检索失败: <reason>')`         |
 * | `rerank()` rejects                 | Caught internally; pipeline continues     |
 * | Empty history / no pronoun trigger | Not an error; rewriting is simply skipped |
 *
 * @param message - The raw user message from the chat request.
 * @param history - Recent conversation history (up to 8 turns). Defaults to `[]`
 *   for the first message in a conversation.
 * @returns A fully assembled {@link RAGPipelineResult} ready for LLM consumption.
 * @throws {Error} When Query Rewrite or Vector Search fails. These are considered
 *   unrecoverable because retrieval without them is meaningless.
 *
 * @example
 * ```ts
 * // First message in a conversation (no history → no rewrite)
 * const result = await runRAGPipeline('React 有哪些安全最佳实践？');
 * // result.wasRewritten === false
 * // result.context contains [1]...[N] citations
 *
 * // Follow-up with a pronoun (has history → rewrite triggered)
 * const result2 = await runRAGPipeline('它的性能如何？', [
 *   { role: 'user', content: 'React 有哪些安全最佳实践？' },
 *   { role: 'assistant', content: '...' },
 * ]);
 * // result2.wasRewritten === true
 * // result2.rewrittenQuery may be 'React 的安全最佳实践性能如何？'
 * ```
 */
export async function runRAGPipeline(
  message: string,
  history: ChatHistoryEntry[] = [],
): Promise<RAGPipelineResult> {
  // Log pipeline entry with a truncated preview to avoid flooding the log with
  // very long messages.
  logger.info(`RAG Pipeline 开始: "${message.slice(0, 50)}..."`);

  // ---- Step 1: Query Rewrite (coreference resolution) ----
  //
  // The rewriteQuery module internally decides whether rewriting is needed by
  // checking (a) the feature flag, (b) history presence, and (c) presence of
  // Chinese pronouns/demonstratives. When all conditions are met, it calls
  // DeepSeek to produce a self-contained query. When any condition is not met,
  // it returns the original message unchanged with wasRewritten=false.
  //
  // This step is FATAL on error: without a coherent query, downstream retrieval
  // would be meaningless.
  let rewriteResult;
  try {
    rewriteResult = await rewriteQuery(message, history);
  } catch (err: any) {
    throw new Error(`查询改写失败: ${err.message}`);
  }
  const query = rewriteResult.rewrittenQuery;

  // ---- Step 2: Vector Search (embedding → ChromaDB similarity) ----
  //
  // The rewritten query is embedded by Ollama (bge-m3 model) into a dense vector.
  // That vector is then used to query ChromaDB for the top-K most similar document
  // chunks via cosine-similarity search. The default K is 10 (configurable via
  // VECTOR_SEARCH_TOP_K).
  //
  // This step is FATAL on error: without retrieved documents there is nothing to
  // augment the LLM generation with.
  let searchResults;
  try {
    searchResults = await vectorSearch(query);
  } catch (err: any) {
    throw new Error(`向量检索失败: ${err.message}`);
  }

  // ---- Step 3: Rerank (relevance scoring and truncation) ----
  //
  // When search results are non-empty, we attempt to rerank them. The reranker
  // module has a two-tier fallback:
  //   Tier 1 — BGE Reranker FastAPI service (if RERANKER_URL is configured).
  //   Tier 2 — DeepSeek LLM-based ranking (always available as long as DeepSeek
  //            API is reachable).
  //
  // When the candidate count is already <= rerankTopK (default 4), the reranker
  // short-circuits and assigns distance-derived scores without calling any
  // external service.
  //
  // This step is NON-FATAL: if reranking fails for any reason (timeout, network
  // error, malformed response), we log a warning and fall through with the
  // original search results. The pipeline continues — the LLM will still receive
  // context, just in distance order rather than relevance order.
  let rankedDocuments = searchResults;
  if (searchResults.length > 0) {
    try {
      const rerankResult = await rerank(query, searchResults);
      rankedDocuments = rerankResult.rankedDocuments;
    } catch (err: any) {
      // Degradation path: use the raw vector-search results (distance-ordered).
      // The LLM still gets useful context; only the ordering may be suboptimal.
      logger.warn('重排序失败，使用原始检索结果:', err.message);
    }
  }

  // ---- Step 4: Context Builder (prompt assembly + reference formatting) ----
  //
  // The ranked documents are transformed into:
  //   context    — a prompt fragment with citation markers ([1], [2], …) that is
  //                injected into the LLM system prompt.
  //   references — a structured array of { id, title, snippet, score } objects
  //                returned to the frontend for citation footnotes.
  //
  // This is a pure synchronous transformation; no external I/O.
  const { context, references } = buildContext(rankedDocuments);

  // Log completion with the reference count for observability.
  logger.info(`RAG Pipeline 完成: ${references.length} 条引用`);

  // Assemble and return the complete pipeline result.
  // - `query` is the original user message (preserved for the caller).
  // - `rewrittenQuery` is what Step 1 produced (may be identical to query).
  // - `wasRewritten` lets the frontend / SSE layer know whether rewriting
  //   actually happened (useful for status events and debugging).
  // - `context` is the assembled prompt fragment for LLM injection.
  // - `references` are the structured citation objects for the frontend.
  // - `documents` are the final ranked documents (useful for tracing / logging).
  return {
    query: message,
    rewrittenQuery: query,
    wasRewritten: rewriteResult.wasRewritten,
    context,
    references,
    documents: rankedDocuments,
  };
}
