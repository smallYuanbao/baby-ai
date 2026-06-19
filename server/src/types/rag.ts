/**
 * RAG (Retrieval-Augmented Generation) Types
 *
 * @fileoverview Shared type definitions for the RAG pipeline, which enriches
 * LLM prompts with relevant knowledge retrieved from a vector store. The
 * pipeline consists of these stages, each with a well-defined input/output
 * contract:
 *
 *   1. Query rewriting  – reformulates the user's raw query to improve recall
 *                          and semantic overlap with indexed documents.
 *   2. Retrieval         – fetches candidate documents from the vector store
 *                          via embedding similarity search (not defined here;
 *                          see the retrieval service).
 *   3. Reranking         – reorders the candidate set so the most relevant
 *                          documents appear first, typically using a cross-
 *                          encoder or lightweight scoring model.
 *   4. Context assembly  – injects the top-K documents into the LLM prompt.
 *
 * Types in this file are consumed by the orchestrator (`RAGService`) and by
 * each stage handler. They serve as the canonical contract between pipeline
 * stages and ensure that every stage returns data the next stage expects.
 *
 * ## Pipeline Contract Summary
 *
 * ```
 * User Query (string)
 *     │
 *     ▼
 * [Query Rewriter]  ──►  RewriteResult
 *     │
 *     ▼
 * [Retriever]       ──►  RAGDocument[]   (unordered candidate set)
 *     │
 *     ▼
 * [Reranker]        ──►  RerankResult
 *     │
 *     ▼
 * [Context Builder] ──►  string           (assembled prompt context)
 * ```
 *
 * Every exported type in this module corresponds to the output of one stage,
 * allowing consumers to type-check the data flowing between stages at compile
 * time.
 */

/**
 * A single document retrieved from or passed through the RAG pipeline.
 *
 * This is the fundamental data carrier of the pipeline. Every stage after
 * retrieval operates on `RAGDocument` instances — the reranker reorders them,
 * and the context assembler extracts `.text` from the top-K.
 *
 * @interface RAGDocument
 */
export interface RAGDocument {
  /**
   * Unique identifier of the document in the source collection / vector store.
   * Used for deduplication, traceability, and debug logging.
   */
  id: string;

  /**
   * The raw text content of the document. This is what ultimately gets
   * injected into the LLM context window, so it is the most critical field
   * for downstream stages.
   */
  text: string;

  /**
   * Optional key-value metadata attached to the document at ingestion time.
   * Typical keys include `source`, `title`, `url`, `page`, `chunkIndex`,
   * `createdAt`, or any custom tags the ingestion pipeline stored.
   *
   * The value is typed as `unknown` because metadata schemas vary across
   * collections. Consumers should guard / narrow the type before use.
   */
  metadata?: Record<string, unknown>;

  /**
   * The raw vector distance returned by the vector store for this document
   * relative to the query embedding. Lower values indicate higher similarity
   * (for distance metrics like L2 or cosine distance); the exact semantics
   * depend on the embedding model and index configuration.
   *
   * May be undefined for documents that did not go through vector retrieval
   * (e.g. keyword-filtered results or manually injected context).
   */
  distance?: number;

  /**
   * A normalized relevance score in the range [0, 1], where 1 means "most
   * relevant." This field is typically populated by the reranker stage and
   * is the primary sort key used by the context assembler to select the top-K
   * documents.
   *
   * May be undefined for documents that have not yet been through the reranker
   * (i.e. the raw candidate set from retrieval).
   */
  score?: number;
}

/**
 * The output of the query-rewriting stage.
 *
 * Query rewriting transforms a short, ambiguous, or domain-specific user query
 * into a semantically richer form that produces better embedding matches
 * against the vector store. Common rewriting strategies include:
 *
 * - **Hypothetical Document Embeddings (HyDE):** generate a plausible answer
 *   document from the query and embed that instead.
 * - **Multi-query expansion:** decompose the query into several sub-queries.
 * - **LLM-based reformulation:** ask an LLM to rewrite the query for clarity.
 * - **Keyword extraction:** pull salient terms and append them.
 *
 * @interface RewriteResult
 */
export interface RewriteResult {
  /**
   * The exact query string the user submitted before any transformation.
   * Preserved for logging, auditing, and fallback scenarios where the
   * rewritten query is deemed unsuitable.
   */
  originalQuery: string;

  /**
   * The query string after rewriting / expansion. This is the string that
   * will be embedded and used for vector similarity search.
   */
  rewrittenQuery: string;

  /**
   * Whether the rewriter actually changed the query. When `false`, the
   * rewritten query is identical to the original query.
   *
   * Consumers can use this flag to short-circuit logging ("query was not
   * rewritten") or to decide whether to run a second retrieval pass with
   * the original query as a fallback.
   */
  wasRewritten: boolean;
}

/**
 * The output of the reranking stage.
 *
 * Reranking takes the raw candidate set from retrieval (which is ordered by
 * embedding distance, a comparatively coarse signal) and reorders it using a
 * more precise relevance model — often a cross-encoder that processes the
 * (query, document) pair jointly.
 *
 * The reranker may also:
 * - Discard documents below a relevance threshold.
 * - Deduplicate near-identical passages.
 * - Boost or penalise documents based on metadata signals (freshness, source
 *   authority, etc.).
 *
 * @interface RerankResult
 */
export interface RerankResult {
  /**
   * The query used for reranking. In the default pipeline this is the
   * **rewritten** query, but some configurations may use the original query
   * or a hybrid of both.
   */
  query: string;

  /**
   * The reranked list of documents, sorted in descending order of relevance
   * (most relevant first).
   *
   * Each document's `score` field is expected to be populated by the reranker.
   * The consumer (context assembler) typically takes the top-K documents from
   * this array.
   */
  rankedDocuments: RAGDocument[];
}
