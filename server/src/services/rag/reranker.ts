/**
 * @fileoverview RAG 文档重排序服务（Reranker）
 *
 * ## 职责
 * 本模块是 RAG 流水线（Retrieval-Augmented Generation）的**精排阶段**，负责对向量召回阶段
 * 返回的候选文档列表进行语义相关性重排序，将最相关的文档排在前面，截断至 topK 条后传递给
 * 下游的答案生成阶段。
 *
 * ## 在架构中的位置
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  RAG 流水线 (services/rag/)                                       │
 * │                                                                    │
 * │  用户查询                                                          │
 * │    │                                                               │
 * │    ▼                                                               │
 * │  queryRewriter.ts  ← 查询改写（多轮对话消解指代、补全上下文）        │
 * │    │                                                               │
 * │    ▼                                                               │
 * │  (ChromaDB / 外部向量库)  ← 向量召回（粗排，按向量距离排序）         │
 * │    │                                                               │
 * │    ▼                                                               │
 * │  reranker.ts  ← 【本模块】精排（语义相关性重排序 + topK 截断）       │
 * │    │                                                               │
 * │    ▼                                                               │
 * │  (routes/chat.ts)  ← 将 topK 文档注入 System Prompt 进行答案生成    │
 * └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 精排策略（两级降级）
 *
 * 本模块采用**优先级链式降级**策略，保障服务在任何条件下都能返回结果：
 *
 * ```
 *  第一优先: BGE Reranker 专用模型（FastAPI 服务）
 *     │  config.rag.rerankerUrl 已配置 → 调用独立部署的 BGE Reranker
 *     │  对 query-document 对进行 Cross-Encoder 打分，精度最高
 *     │
 *     ├── 不可用时降级 ──→
 *     │
 *  第二优先: DeepSeek LLM 排序（兜底方案）
 *     │  config.rag.rerankerUrl 未配置 / BGE 超时 / BGE 异常
 *     │  → 将候选文档列表发送给 DeepSeek，让 LLM 选出最相关的 topK 条
 *     │
 *     ├── 不可用时降级 ──→
 *     │
 *  最终兜底: 原始向量距离排序
 *        DeepSeek 也失败 → 按原始 distance 升序排列，取前 topK 条
 *        保证即使所有外部依赖都不可用，RAG 仍然可以完成
 * ```
 *
 * ## 短路优化
 *
 * 当召回文档数量 ≤ topK 时，**跳过所有精排逻辑**，直接按向量距离转换为 score 后返回。
 * 此优化避免了不必要的网络调用，覆盖了召回数量不足的常见场景。
 *
 * ## 启动预热
 *
 * 导出 `prewarmReranker()` 函数，在 server 启动流程中调用，提前触发 BGE Reranker
 * 模型的首次推理。深度学习模型的首次推理通常包含模型加载、CUDA kernel 编译等冷启动开销，
 * 预热确保第一个真实用户的请求不会遭遇额外延迟。
 *
 * ## 调用方
 *
 * | 调用方 | 使用的函数 | 用途 |
 * |---|---|---|
 * | `routes/chat.ts` | `rerank` | 在知识库问答流程中精排召回文档 |
 * | `server/src/index.ts` | `prewarmReranker` | 启动时预热 BGE Reranker 模型 |
 *
 * @module rag/reranker
 */

import { chat } from '../deepseek.js';
import type { RAGDocument, RerankResult } from '../../types/rag.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * BGE Reranker 请求超时时间（毫秒）。
 *
 * 设置为 60 秒，因为推理模型的首次请求可能包含模型加载、GPU 预热等冷启动耗时。
 * 经过预热后，后续请求通常在 1-5 秒内完成。如果服务部署在 CPU 上，可能需要更长时间。
 */
const RERANK_TIMEOUT_MS = 60000; // 30 秒超时（首次推理模型预热较慢）

/**
 * 启动时预热 BGE Reranker 服务，避免第一个用户踩到冷启动。
 *
 * ## 背景
 * BGE Reranker 是一个基于 Cross-Encoder 架构的深度学习模型。首次推理时：
 * - 模型需要从磁盘加载到 GPU/CPU 内存（模型权重通常数百 MB）
 * - 如果使用 GPU，CUDA kernel 需要首次编译
 * - 这些操作可能需要 10-60 秒，远超正常推理的 1-5 秒
 *
 * ## 行为
 * 发送一个无意义的预热请求（query="预热"），强制触发首次推理。预热结果被丢弃，
 * 只关心请求是否成功完成。
 *
 * ## 容错
 * 预热失败**不阻塞启动**，仅输出 warn 日志。第一个真实用户的请求将承担冷启动延迟，
 * 但由于 BGE Reranker 调用已有 60 秒超时保护，不会导致请求失败。
 *
 * ## 调用时机
 * 在 server 启动流程中，`index.ts` 在所有外部依赖初始化完成后调用此函数。
 *
 * @returns Promise<void> — 预热完成或失败（永不抛出，所有异常内部捕获）
 */
export async function prewarmReranker(): Promise<void> {
  const url = config.rag.rerankerUrl;
  // 如果未配置 Reranker URL，跳过预热（运行时将使用 DeepSeek 排序作为兜底）
  if (!url) return;

  try {
    logger.info('预热 BGE Reranker...');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '预热',
        documents: [{ id: 'prewarm', text: '这是一个预热请求' }],
        top_k: 1,
      }),
      // 预热给 60 秒超时，覆盖模型首次加载的完整耗时
      signal: AbortSignal.timeout(60000), // 预热给 60 秒
    });
    if (response.ok) {
      logger.info('BGE Reranker 预热完成 ✅');
    }
  } catch (err: any) {
    // 预热失败不阻塞启动 — 运行时将通过降级链路（DeepSeek → 原始排序）兜底
    logger.warn(`BGE Reranker 预热失败: ${err.message}，将在首次请求时加载`);
  }
}

/**
 * 调用独立的 BGE Reranker 服务（FastAPI）进行 Cross-Encoder 精排。
 *
 * ## 协议
 *
 * BGE Reranker 服务对外暴露 HTTP POST 接口，接受如下 JSON 请求体：
 * ```json
 * {
 *   "query": "用户查询文本",
 *   "documents": [
 *     { "id": "doc_001", "text": "文档内容..." },
 *     { "id": "doc_002", "text": "文档内容..." }
 *   ],
 *   "top_k": 5
 * }
 * ```
 *
 * 返回 JSON 响应体：
 * ```json
 * {
 *   "results": [
 *     { "id": "doc_002", "score": 0.95 },
 *     { "id": "doc_001", "score": 0.72 }
 *   ]
 * }
 * ```
 *
 * 其中 score 是 BGE Cross-Encoder 对 (query, document) 对的相关性打分，范围通常
 * 为 [0, 1]，分数越高表示语义相关性越强。
 *
 * ## 内部实现步骤
 *
 * 1. **检查配置**：如果 `config.rag.rerankerUrl` 未配置，立即返回 null，触发降级。
 * 2. **构建请求**：将 `RAGDocument[]` 映射为 `{id, text}` 格式发送给 Reranker 服务。
 * 3. **超时控制**：使用 `AbortController` + `RERANK_TIMEOUT_MS` 防止请求无限等待。
 * 4. **结果映射**：将 Reranker 返回的 `{id, score}` 列表与原始文档关联，按 score
 *    降序排列，将 score 附加到文档对象上。
 *
 * ## 错误处理与降级
 *
 * - **HTTP 非 2xx**：抛出 Error，触发降级到 DeepSeek 排序。
 * - **请求超时** (`AbortError`)：记录 warn 日志，返回 null 触发降级。
 * - **网络错误 / DNS 解析失败**：记录 warn 日志，返回 null 触发降级。
 * - **返回 null 不抛出**：所有异常在内部捕获，通过 null 返回值向调用方 `rerank()`
 *   传递"此路径不可用"的信号，由调用方执行降级。
 *
 * @param query - 用户当前的查询文本（已通过 queryRewriter 改写后的版本）
 * @param documents - 向量召回阶段返回的候选文档列表，每个文档含 id、text、distance
 * @param topK - 需要保留的文档数量，传递给 Reranker 服务的 top_k 参数
 * @returns 按 score 降序排列的 topK 条文档，每个文档的 score 字段已填充；或 null 表示 BGE Reranker 不可用，需降级
 */
async function callBGEReranker(
  query: string,
  documents: RAGDocument[],
  topK: number,
): Promise<RAGDocument[] | null> {
  // 检查 Reranker URL 是否已配置 — 未配置时静默跳过，由调用方降级到 DeepSeek
  const url = config.rag.rerankerUrl;
  if (!url) return null;

  // 创建 AbortController 用于超时控制
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

  try {
    // 发送 POST 请求到 BGE Reranker 服务
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        // 只发送 id 和 text — distance 是向量阶段的产物，对 Cross-Encoder 无意义
        documents: documents.map((d) => ({ id: d.id, text: d.text })),
        top_k: topK,
      }),
      signal: controller.signal,
    });

    // HTTP 错误响应（4xx, 5xx）视为不可恢复的错误
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // 解析 Reranker 返回的排序结果
    const data = (await response.json()) as {
      results: Array<{ id: string; score: number }>;
    };

    // 构建 id → score 映射表，O(1) 查找
    const scoreMap = new Map(data.results.map((r) => [r.id, r.score]));

    // 将 score 映射回原始文档对象：
    // 1. 过滤：只保留 Reranker 返回了分数的文档（理论上应该全部返回）
    // 2. 排序：按 score 降序（高分优先）
    // 3. 附加：将 score 写入文档对象的 score 字段
    const ranked = documents
      .filter((d) => scoreMap.has(d.id))
      .sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0))
      .map((d) => ({ ...d, score: scoreMap.get(d.id) || 0 }));

    logger.debug(`BGE Reranker 完成: ${ranked.length} 条`);
    return ranked;
  } catch (err: any) {
    // 区分超时与其他异常，便于运维排查
    if (err.name === 'AbortError') {
      logger.warn('BGE Reranker 请求超时，回退到 DeepSeek 排序');
    } else {
      logger.warn(`BGE Reranker 不可用 (${err.message})，回退到 DeepSeek 排序`);
    }
    // 返回 null 通知调用方降级，而非抛出异常
    return null;
  } finally {
    // 无论成功还是失败，清理定时器防止内存泄漏
    clearTimeout(timeout);
  }
}

/**
 * 使用 DeepSeek LLM 对召回的文档进行语义相关性排序（第二优先级的兜底方案）。
 *
 * ## 使用场景
 *
 * 当 BGE Reranker 服务不可用时（未配置 URL、超时、网络错误、服务宕机），本函数
 * 作为降级方案被启用。它向 LLM 发送候选文档列表，利用 LLM 的语言理解能力筛选出
 * 与查询最相关的 topK 条文档。
 *
 * ## 算法步骤
 *
 * 1. **格式化文档列表**：将每个文档的前 200 字符编号后拼接到 prompt 中。
 *    截断到 200 字符是为了控制 prompt 长度，避免超出 LLM 的上下文窗口。
 * 2. **构建排序 Prompt**：请求 LLM 输出最相关文档的编号，每行一个。
 *    使用 `temperature: 0` 确保排序结果稳定可复现。
 * 3. **解析 LLM 输出**：
 *    - 按行分割输出
 *    - 每行尝试解析为整数编号
 *    - 过滤无效值（NaN、负数、超出文档索引范围）
 *    - 截断至 topK 条
 * 4. **分配分数**：按排名位置分配递减的 score（第 1 名 ≈ 1.0，依次递减）。
 *    这是一种人造的平滑分数，确保下游可以统一使用 score 字段。
 *
 * ## Prompt 设计
 *
 * ```
 * 从下列文档中选出与查询最相关的 N 条，每行输出一个编号（只输出数字）：
 *
 * 查询：<用户查询>
 *
 * [0] 文档内容前200字...
 * [1] 文档内容前200字...
 * ...
 * ```
 *
 * 要求"只输出数字"是为了让解析逻辑简单可靠。LLM 可能偶尔输出额外文字（如 "我认为是..."），
 * `parseInt` 会自动跳过非数字行。
 *
 * ## 容错与降级
 *
 * - **LLM 输出无法解析**（无有效编号）：回退到按原始 distance 排序，取前 topK 条。
 * - **LLM 完全不可用**（网络错误等）：抛出异常，由上层 `rerank()` 的 `try/catch` 处理，
 *   降级到最终兜底方案（原始向量距离排序）。
 *
 * @param query - 用户当前的查询文本
 * @param documents - 向量召回阶段返回的候选文档列表
 * @param topK - 需要保留的文档数量
 * @returns 按相关性降序排列的 topK 条文档，每个文档的 score 字段已填充
 * @throws 当 DeepSeek API 调用本身失败时抛出（网络错误、API key 无效等），由上层处理
 */
async function rerankWithDeepSeek(
  query: string,
  documents: RAGDocument[],
  topK: number,
): Promise<RAGDocument[]> {
  logger.debug(`DeepSeek 排序: ${documents.length} 条 → topK=${topK}`);

  // 步骤 1: 格式化文档列表 — 截断每篇文档的前 200 字以控制 prompt 长度
  // 编号 [i] 与文档在数组中的索引对应，后续解析时通过编号反查原始文档
  const docListText = documents
    .map((d, i) => `[${i}] ${d.text.slice(0, 200)}`)
    .join('\n\n');

  // 步骤 2: 调用 DeepSeek LLM 进行排序
  // temperature: 0 确保输出确定性 — 相同输入始终得到相同排序
  // maxTokens: 50 足够容纳 topK 个编号（每个编号 + 换行约 2-3 token）
  const { content } = await chat(
    [{
      role: 'user',
      content: `从下列文档中选出与查询最相关的 ${topK} 条，每行输出一个编号（只输出数字）：\n\n查询：${query}\n\n${docListText}`,
    }],
    { temperature: 0, maxTokens: 50 },
  );

  // 步骤 3: 解析 LLM 输出 — 从文本中提取文档编号
  // - trim() 去除首尾空白
  // - split('\n') 按行分割
  // - parseInt 将每行解析为整数
  // - filter 保留有效编号：非 NaN、非负数、不超过文档数量上限
  const indices = content
    .trim()
    .split('\n')
    .map((line) => parseInt(line.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 0 && n < documents.length)
    .slice(0, topK);

  // 步骤 4: 容错 — LLM 输出全无效时的兜底
  // 当 indices 为空（所有行都无法解析为有效编号）时，回退到原始向量距离排序
  if (indices.length === 0) {
    // score = 1 - distance：distance 越小表示越相关，转换为 0-1 的正向分数
    return documents.slice(0, topK).map((d, i) => ({
      ...d,
      score: 1 - (d.distance || 0),
    }));
  }

  // 步骤 5: 按 LLM 选择的顺序重排文档，并分配递减的分数
  // rank 从 0 开始：第 1 名 score ≈ 1.0，第 topK 名 score ≈ 0
  return indices.map((idx, rank) => ({
    ...documents[idx],
    score: 1 - rank / topK,
  }));
}

/**
 * 文档重排序（Rerank）— RAG 流水线精排阶段的入口函数。
 *
 * ## 输入/输出契约
 *
 * | 参数 | 类型 | 来源 | 说明 |
 * |---|---|---|---|
 * | `query` | `string` | 上游 `queryRewriter.rewrite()` 的输出 | 已消解指代、补全上下文的查询文本 |
 * | `documents` | `RAGDocument[]` | 上游向量库（ChromaDB）的召回结果 | 每个文档需含 `id`, `text`, `distance` |
 * | `topK` | `number` | `config.rag.rerankTopK`（默认值） | 需要保留的文档数量 |
 *
 * | 返回值 | 类型 | 下游消费者 | 说明 |
 * |---|---|---|---|
 * | `RerankResult` | `{ query, rankedDocuments }` | `routes/chat.ts` 的答案生成阶段 | `rankedDocuments` 按 score 降序，每个文档已填充 `score` 字段 |
 *
 * ## 处理流程
 *
 * ```
 *                     ┌─────────────────────┐
 *                     │   documents.length   │
 *                     │     ≤ topK ?          │
 *                     └──────────┬──────────┘
 *                                │
 *                 ┌──────────────┼──────────────┐
 *                 │ YES          │              │ NO
 *                 ▼              │              ▼
 *    ┌─────────────────────┐      │   ┌─────────────────────────┐
 *    │ 短路：直接转换为      │      │   │ callBGEReranker()       │
 *    │ score 后返回          │      │   │ (第一优先：BGE 精排)     │
 *    │ score = 1 - distance  │      │   └───────────┬─────────────┘
 *    └─────────────────────┘      │                │
 *                                 │   ┌────────────┼────────────┐
 *                                 │   │ 返回结果    │            │
 *                                 │   │ (ranked)    │ 返回 null  │
 *                                 │   │              │ (不可用)    │
 *                                 │   ▼              ▼            │
 *                                 │  ┌──────┐  ┌─────────────────┐
 *                                 │  │ 完成  │  │rerankWithDeepSeek│
 *                                 │  │      │  │ (第二优先：LLM)   │
 *                                 │  └──────┘  └────────┬────────┘
 *                                 │                      │
 *                                 │          ┌───────────┼───────────┐
 *                                 │          │ 成功       │            │
 *                                 │          │            │ 抛出异常    │
 *                                 │          ▼            ▼            │
 *                                 │     ┌──────┐   ┌─────────────────┐
 *                                 │     │ 完成  │   │ 最终兜底：        │
 *                                 │     │      │   │ 按 distance 排序  │
 *                                 │     └──────┘   │ 取前 topK 条       │
 *                                 │                 └─────────────────┘
 *                                 │
 *                                 ▼
 *                          ┌──────────────┐
 *                          │ 返回          │
 *                          │ RerankResult  │
 *                          └──────────────┘
 * ```
 *
 * ## score 字段语义
 *
 * `score` 是文档与查询相关性的归一化分数，来源取决于实际执行的路径：
 *
 * | 精排路径 | score 来源 | 范围 |
 * |---|---|---|
 * | BGE Reranker | Cross-Encoder 打分 | [0, 1]，真实语义相关性 |
 * | DeepSeek 排序 | 排名位置递减 `1 - rank/topK` | [0, 1]，人造相对分数 |
 * | 短路 / 最终兜底 | 向量距离转换 `1 - distance` | 取决于向量空间，通常 [0, 1] |
 *
 * 下游代码可以统一使用 `score` 字段排序或过滤，无需关心具体来源。
 *
 * @param query - 用户当前的查询文本（已通过 queryRewriter 改写）
 * @param documents - 向量召回阶段返回的候选文档列表
 * @param topK - 需要保留的文档数量，默认从 `config.rag.rerankTopK` 读取
 * @returns 重排序结果，包含原查询文本和按 score 降序排列的 topK 条文档
 */
export async function rerank(
  query: string,
  documents: RAGDocument[],
  topK: number = config.rag.rerankTopK,
): Promise<RerankResult> {
  // 短路优化：文档数不超过 topK 时，无需排序，直接转换为 score 返回
  // score = 1 - distance：将向量距离（越小越相关）转换为正向分数（越大越相关）
  if (documents.length <= topK) {
    logger.debug('文档数 ≤ topK，跳过重排序');
    return {
      query,
      rankedDocuments: documents.map((d) => ({
        ...d,
        score: 1 - (d.distance || 0),
      })),
    };
  }

  logger.debug(`重排序: ${documents.length} 条 → topK=${topK}`);

  let ranked: RAGDocument[] | null = null;

  // 第一优先：尝试 BGE Reranker 专用模型
  // 返回 null 表示不可用（未配置 / 超时 / 网络错误），调用方继续降级
  ranked = await callBGEReranker(query, documents, topK);

  // 第二优先：BGE 不可用时，回退到 DeepSeek LLM 排序
  if (!ranked) {
    try {
      ranked = await rerankWithDeepSeek(query, documents, topK);
    } catch (err: any) {
      // 最终兜底：DeepSeek 也失败时，按原始向量距离排序
      // 确保即使所有外部服务都不可用，RAG 仍能返回结果
      logger.warn(`DeepSeek 排序也失败: ${err.message}，使用原始检索结果`);
      ranked = documents.slice(0, topK).map((d) => ({
        ...d,
        score: 1 - (d.distance || 0),
      }));
    }
  }

  logger.debug(`重排序完成: 最终 ${ranked.length} 条`);
  return { query, rankedDocuments: ranked };
}
