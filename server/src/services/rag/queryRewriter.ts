import { chat } from '../deepseek.js';
import type { ChatHistoryEntry } from '../../types/chat.js';
import type { RewriteResult } from '../../types/rag.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * Query Rewriter — RAG Pipeline Stage 1: Anaphora Resolution
 *
 * ## Responsibility
 *
 * Converts context-dependent, multi-turn queries into self-contained, standalone
 * queries before they enter the retrieval stage. Without this step, a follow-up
 * question like "What about his later work?" would be sent verbatim to the vector
 * store, producing irrelevant results because the embedding has no knowledge of
 * the preceding conversation.
 *
 * ## Role in the RAG Architecture
 *
 * ```
 * User Message + Chat History
 *         │
 *         ▼
 * ┌───────────────────────┐
 * │   queryRewriter.ts    │  ◄── THIS FILE
 * │  (Anaphora Resolution) │
 * └───────────┬───────────┘
 *             │  RewriteResult { rewrittenQuery }
 *             ▼
 * ┌───────────────────────┐
 * │      retriever.ts      │
 * │   (Vector Search)      │
 * └───────────┬───────────┘
 *             │  RAGDocument[]
 *             ▼
 * ┌───────────────────────┐
 * │      reranker.ts       │
 * │   (Relevance Scoring)  │
 * └───────────┬───────────┘
 *             │  RerankResult
 *             ▼
 * ┌───────────────────────┐
 * │      generator.ts      │
 * │   (LLM Answer Gen)     │
 * └───────────────────────┘
 * ```
 *
 * ## Input/Output Contract
 *
 * | Stage        | Input                                    | Output              |
 * |------------- |------------------------------------------|---------------------|
 * | needsRewrite | `string` (message), `ChatHistoryEntry[]` | `boolean`           |
 * | rewriteQuery | `string` (message), `ChatHistoryEntry[]` | `RewriteResult`     |
 *
 * `RewriteResult.rewrittenQuery` is then forwarded to the retriever as the
 * search query. The `originalQuery` is preserved for logging and debugging.
 *
 * ## Degradation / Fallback
 *
 * - If `config.rag.queryRewriteEnabled` is `false`, rewriting is skipped
 *   entirely (the message passes through unchanged).
 * - If there is no chat history, rewriting is skipped (first-turn queries are
 *   already standalone by definition).
 * - If the message contains no Chinese pronouns/demonstratives, rewriting is
 *   skipped (heuristic short-circuit to avoid unnecessary LLM calls).
 * - If the DeepSeek API call fails (network error, timeout, rate limit, etc.),
 *   the original query is returned with `wasRewritten: false` — the RAG
 *   pipeline degrades gracefully rather than blocking the user.
 *
 * ## Why DeepSeek Instead of the Main Model?
 *
 * Query rewriting is a lightweight, low-temperature task. Offloading it to
 * DeepSeek (a smaller, faster, cheaper model) keeps the main generation model
 * free for the actual answer synthesis. The prompt is engineered to produce a
 * single-line rewrite with no extraneous output.
 *
 * @module queryRewriter
 */

/**
 * Chinese pronoun / demonstrative detection pattern.
 *
 * Matches common Chinese anaphoric expressions that signal the current message
 * depends on prior conversation context:
 *
 * - Personal pronouns: 他, 她, 它, 他们, 她们, 它们
 * - Demonstrative pronouns: 这些, 那些, 这个, 那个
 * - Locative references: 这里, 那里
 * - Manner references: 这样, 那样
 *
 * This is used as a fast, zero-cost heuristic gate before invoking the LLM
 * for full rewrite. If none of these tokens appear, the query is almost
 * certainly standalone and can skip the rewrite step.
 */
const PRONOUN_PATTERN = /(他|她|它|他们|她们|它们|这些|那些|这个|那个|这里|那里|这样|那样)/;

/**
 * Fast heuristic gate that determines whether the current message requires
 * anaphora resolution before being sent to the retriever.
 *
 * Three conditions must ALL be met for a rewrite to be warranted:
 *
 * 1. **Feature flag enabled** — `config.rag.queryRewriteEnabled` must be
 *    `true`. This allows operators to disable rewriting globally without
 *    a redeploy (e.g., during an incident or cost-saving period).
 *
 * 2. **Non-empty history** — There must be prior conversation turns. A
 *    first message in a session has no anaphora to resolve.
 *
 * 3. **Pronoun detected** — The message must contain at least one Chinese
 *    pronoun or demonstrative (matched by {@link PRONOUN_PATTERN}). This
 *    avoids calling the LLM for messages like "What is TypeScript?" that
 *    are already standalone.
 *
 * This function is intentionally synchronous and allocation-free (beyond the
 * regex test) so it can be called on every incoming message without concern
 * for latency.
 *
 * @param message  - The raw user message from the current turn.
 * @param history  - The conversation history up to (but not including) this
 *                   turn. May be `undefined` or an empty array.
 * @returns `true` if the message should be rewritten before retrieval,
 *          `false` if it can be used as-is.
 */
export function needsRewrite(message: string, history?: ChatHistoryEntry[]): boolean {
  // Gate 1: Global feature flag — allows ops to disable rewriting at runtime.
  if (!config.rag.queryRewriteEnabled) return false;

  // Gate 2: First turn has no prior context to resolve against.
  if (!history || history.length === 0) return false;

  // Gate 3: Fast regex check — if no pronouns/demonstratives exist,
  // the query is already self-contained.
  return PRONOUN_PATTERN.test(message);
}

/**
 * Resolves anaphora in the user's message by rewriting it against the
 * conversation history, producing a standalone query suitable for vector
 * search.
 *
 * ## Algorithm
 *
 * 1. Call {@link needsRewrite} as a guard — if no rewrite is needed, return
 *    the original message unchanged with `wasRewritten: false`.
 * 2. Serialize the chat history into a labelled text block (用户/助手 prefixes
 *    for user/assistant turns).
 * 3. Construct a few-shot-style prompt instructing DeepSeek to replace all
 *    pronouns and demonstratives with their concrete referents from the
 *    history.
 * 4. Call DeepSeek with low temperature (0.3) and a tight token budget (200)
 *    to encourage deterministic, concise output.
 * 5. Trim the response. If the LLM returns an empty string (unlikely but
 *    possible under extreme failure modes), fall back to the original query.
 *
 * ## Error Handling
 *
 * Any exception thrown by the DeepSeek API call (network errors, timeouts,
 * rate limiting, 5xx responses) is caught at the top level. The function
 * logs a warning and returns the original query with `wasRewritten: false`.
 * This ensures a single-stage failure does not cascade into a failed user
 * request — the retrieval and generation stages still execute, just with a
 * potentially suboptimal query.
 *
 * @param message - The raw user message from the current turn, potentially
 *                  containing unresolved pronouns or demonstratives.
 * @param history - The full conversation history up to this turn. Must be
 *                  non-empty for rewriting to occur; otherwise the message
 *                  is returned unchanged.
 * @returns A {@link RewriteResult} containing:
 *          - `originalQuery`: the unmodified input message (for audit/logging).
 *          - `rewrittenQuery`: the resolved, standalone query (or the original
 *            if rewriting was skipped or failed).
 *          - `wasRewritten`: `true` if the LLM successfully produced a
 *            different query, `false` otherwise.
 *
 * @throws Never throws — all errors are caught and degraded gracefully.
 */
export async function rewriteQuery(
  message: string,
  history: ChatHistoryEntry[],
): Promise<RewriteResult> {
  // Guard: skip rewriting if the message is already standalone or the feature
  // is disabled. Returns a pass-through result so upstream callers can treat
  // all code paths uniformly.
  if (!needsRewrite(message, history)) {
    return {
      originalQuery: message,
      rewrittenQuery: message,
      wasRewritten: false,
    };
  }

  logger.debug('检测到代词，执行指代消解...');

  // Serialize conversation history into a labelled text block.
  // Each turn is prefixed with 用户 (user) or 助手 (assistant) so the LLM
  // can distinguish who said what when resolving referents.
  const historyText = history
    .map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`)
    .join('\n');

  // Prompt design: we instruct the model to output ONLY the rewritten query
  // on a single line with no explanation, prefix, or markdown wrapping.
  // This keeps post-processing trivial (just .trim()) and avoids token waste
  // on conversational filler.
  const rewritePrompt = `你是一个查询改写助手。请根据对话历史，将用户当前的问题改写为一个独立、完整的查询语句。去除代词（如"他"、"这个"、"那些"等），替换为具体的指代内容。

对话历史：
${historyText}

用户当前问题：${message}

请直接输出改写后的查询语句（一行，不要加任何解释）：`;

  try {
    // Call DeepSeek with low temperature for deterministic rewrites and a
    // tight maxTokens cap — rewritten queries should never exceed ~50 tokens
    // in practice; 200 is a generous safety margin.
    const { content } = await chat(
      [{ role: 'user', content: rewritePrompt }],
      { temperature: 0.3, maxTokens: 200 },
    );

    const rewritten = content.trim();
    logger.debug(`指代消解结果: "${message}" → "${rewritten}"`);

    return {
      originalQuery: message,
      // Fall back to the original message if the LLM returned an empty string
      // (extremely rare, but guards against a malformed response breaking the
      // downstream retrieval stage).
      rewrittenQuery: rewritten || message,
      wasRewritten: true,
    };
  } catch (err) {
    // Degrade gracefully: log the error and return the original query.
    // The RAG pipeline continues with the un-rewritten query — retrieval
    // quality may suffer for pronoun-heavy follow-ups, but the user still
    // gets a response rather than an error.
    logger.warn('指代消解失败，使用原始查询:', err);
    return {
      originalQuery: message,
      rewrittenQuery: message,
      wasRewritten: false,
    };
  }
}
