/**
 * ChromaDB 向量数据库服务
 *
 * ## 职责
 * 本服务封装了与 ChromaDB 向量数据库的所有交互，是 RAG（检索增强生成）管道的
 * **存储与检索层**。它负责：
 * - 管理 ChromaDB 客户端连接（懒初始化 + 连接复用）
 * - 创建/获取 collection（集合），以 `cosine` 距离度量为默认相似度算法
 * - 向指定 collection 写入文档及其 embedding 向量（持久化）
 * - 执行单集合向量检索（ANN 近似最近邻搜索）
 * - 编排多集合并行检索并合并排序结果（多知识库联合召回）
 *
 * ## 架构角色
 * ```
 * 用户查询 → 查询重写(rewrite) → Embedding 生成 → [本服务: 多集合向量检索]
 *   → Reranker 精排 → LLM 生成回答
 * ```
 * 本服务处于 RAG 管道的**召回阶段**：接收上游生成的查询 embedding，返回 topK 条
 * 最相似的文档候选。它不参与重写、精排或生成，输出是后续 Reranker 的输入。
 *
 * ## 关键设计决策
 * - **懒初始化**: ChromaClient 在首次调用时创建，避免启动时阻塞
 * - **连接复用**: 全局单例 client，所有请求共享同一连接
 * - **优雅降级**: 单集合搜索失败时返回空数组，不中断多集合检索流程
 * - **多集合并行**: 使用 Promise.all 并发搜索所有配置的集合，减少端到端延迟
 * - **按配额分配**: topK 按集合数均分，确保各知识库公平参与召回
 *
 * ## 配置依赖
 * - `config.chroma.url`: ChromaDB 服务地址（如 http://localhost:8000）
 * - `config.chroma.searchCollections`: 参与育儿检索的集合名列表
 * - `config.chroma.sampleCollection`: 默认写入集合名
 * - `config.rag.vectorSearchTopK`: 向量检索召回总数
 */

import { ChromaClient } from 'chromadb';
import { config } from '../config/index.js';
import type { RAGDocument } from '../types/rag.js';
import logger from '../utils/logger.js';

/**
 * ChromaDB 客户端全局单例。
 * - `null` 表示尚未初始化（懒初始化）
 * - 初始化后在整个进程生命周期内复用
 */
let client: ChromaClient | null = null;

/**
 * 获取 ChromaDB 客户端实例（懒初始化 + 单例模式）。
 *
 * 首次调用时创建连接，后续调用直接返回已有实例。
 * 连接失败时抛出明确的中文错误信息。
 *
 * @returns ChromaClient 实例
 * @throws {Error} 当无法连接到 ChromaDB 服务时抛出
 */
function getClient(): ChromaClient {
  if (!client) {
    logger.debug(`连接 ChromaDB: ${config.chroma.url}`);
    try {
      // 使用 path 参数连接本地或自托管 ChromaDB 实例
      client = new ChromaClient({ path: config.chroma.url });
    } catch (err: any) {
      // 连接失败是致命错误，抛出后由上层决定是否重试或降级
      throw new Error(`无法连接 ChromaDB (${config.chroma.url}): ${err.message}`);
    }
  }
  return client;
}

/**
 * 获取或创建指定名称的 ChromaDB collection。
 *
 * 采用"先获取、不存在则创建"的策略，保证幂等性：
 * 多次调用同一 collection 名不会创建重复集合。
 *
 * **输入契约**: 调用方只需提供 collection 名称
 * **输出契约**: 返回一个可执行 query/add 操作的 collection 句柄
 * **错误处理**: 获取失败且不是"不存在"错误时，抛出连接错误提示检查服务状态
 *              创建失败时，抛出创建错误
 *
 * @param name - collection 名称，对应一个独立的向量存储空间
 * @returns ChromaDB collection 实例（含 query/add 等操作方法）
 * @throws {Error} 当 ChromaDB 连接失败或创建集合失败时抛出
 */
async function getOrCreateCollection(name: string) {
  const c = getClient();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (c as any).getCollection({ name });
  } catch (err: any) {
    // 检查是否是"集合不存在"的错误，不同版本 ChromaDB 错误信息可能不同
    if (err.message?.includes('does not exist') || err.message?.includes('not found')) {
      logger.info(`创建 Chroma collection: ${name}`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (c as any).createCollection({
          name,
          // 使用余弦距离作为相似度度量 —— 更适合文本语义匹配场景
          metadata: { 'hnsw:space': 'cosine' },
        });
      } catch (createErr: any) {
        throw new Error(`ChromaDB 创建集合失败 (${name}): ${createErr.message}`);
      }
    }
    // 非"不存在"错误（连接超时、权限等），直接抛出并给出排查建议
    throw new Error(`ChromaDB 连接失败: ${err.message}. 请确认服务已启动 (${config.chroma.url})`);
  }
}

/**
 * 在单个 collection 中执行向量相似度检索。
 *
 * 这是 RAG 召回阶段的最小单位操作：
 * 1. 确保目标 collection 存在（自动创建）
 * 2. 执行 ANN 近似最近邻查询
 * 3. 将 ChromaDB 原生返回格式标准化为 RAGDocument[]
 *
 * **输入契约**:
 * - `collectionName`: 已配置的集合名（或将被自动创建）
 * - `embedding`: 查询文本的 embedding 向量（由上游 Embedding 服务生成）
 * - `topK`: 期望返回的文档数量
 *
 * **输出契约**:
 * - 成功: RAGDocument[]，每个文档含 id、text、metadata（附加 `_collection` 来源标记）、distance
 * - 失败: []（空数组）—— 优雅降级，不中断多集合并行检索
 *
 * **降级策略**: 任何异常（连接断开、collection 损坏等）均被捕获，记录警告日志后返回空数组。
 * 这使得单集合故障不会拖垮整个多集合检索流程。
 *
 * @param collectionName - 目标 collection 名称
 * @param embedding - 查询文本的 embedding 向量
 * @param topK - 期望检索的文档数量
 * @returns 匹配的文档列表，按距离升序（越小越相似）；失败时返回空数组
 */
async function searchCollection(
  collectionName: string,
  embedding: number[],
  topK: number,
): Promise<RAGDocument[]> {
  try {
    // Step 1: 获取或创建 collection
    const collection = await getOrCreateCollection(collectionName);

    // Step 2: 执行 ANN 向量检索
    // queryEmbeddings 接受二维数组（支持批量查询，这里单查询）
    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: topK,
    });

    // Step 3: 解析 ChromaDB 返回格式
    // ChromaDB 返回的是二维数组，第一维对应查询批次（此处仅1个查询）
    // 各字段按结果顺序对齐：ids[i] ↔ documents[i] ↔ metadatas[i] ↔ distances[i]
    const ids = results.ids?.[0] || [];
    const documents = results.documents?.[0] || [];
    const metadatas = results.metadatas?.[0] || [];
    const distances = results.distances?.[0] || [];

    // Step 4: 标准化为 RAGDocument[]，附加来源集合标记
    const docs: RAGDocument[] = [];
    for (let i = 0; i < ids.length; i++) {
      docs.push({
        id: ids[i] || `doc_${i}`,
        text: documents[i] || '',
        // 将 collection 名注入 metadata，便于下游追溯文档来源
        metadata: { ...(metadatas[i] as Record<string, unknown> || {}), _collection: collectionName },
        distance: distances[i] as number | undefined,
      });
    }
    return docs;
  } catch (err: any) {
    // 优雅降级：记录警告后返回空数组，不向上抛出
    logger.warn(`搜索集合 ${collectionName} 失败: ${err.message}`);
    return [];
  }
}

/**
 * 多集合向量检索 —— RAG 管道的**核心召回入口**。
 *
 * ## 算法流程
 * ```
 * 1. 配额分配: topK / collections.length（向上取整），确保每个集合公平参与
 * 2. 并行检索: Promise.all 并发搜索所有配置集合
 * 3. 结果合并: flat() 展平各集合结果
 * 4. 距离排序: 按 distance 升序排列（余弦距离，越小越相似）
 * 5. 截断返回: 取前 topK 条作为最终召回结果
 * ```
 *
 * ## 输入契约
 * - `embedding`: 上游 Embedding 服务对用户查询（或改写后查询）生成的向量
 * - `topK`: 期望召回总数，默认取自 `config.rag.vectorSearchTopK`
 *
 * ## 输出契约
 * - 返回 RAGDocument[]，长度 ≤ topK，按相似度降序（distance 升序）
 * - 返回结果将被传递给 Reranker 进行精排
 * - 每个文档的 metadata 中保留 `_collection` 字段标识来源集合
 *
 * ## 容错设计
 * - 单个集合检索失败不影响其他集合（searchCollection 内部降级返回 []）
 * - 所有集合均失败时返回空数组 []，不会中断整个 RAG 流程
 * - 距离缺失的文档赋默认值 999（排在末尾），确保排序稳定
 *
 * **注意**: `rag_resume` 集合不在 `searchCollections` 中，不参与育儿检索。
 * 该集合仅用于简历相关功能，由独立的检索路径处理。
 *
 * @param embedding - 查询文本的 embedding 向量（数字数组）
 * @param topK - 召回文档总数上限，默认 config.rag.vectorSearchTopK
 * @returns 合并去重后按距离排序的文档列表，长度 ≤ topK
 */
export async function searchByEmbedding(
  embedding: number[],
  topK: number = config.rag.vectorSearchTopK,
): Promise<RAGDocument[]> {
  const collections = config.chroma.searchCollections;

  // Step 1: 计算每个集合的检索配额（向上取整，确保不遗漏）
  const perCollection = Math.ceil(topK / collections.length);

  // Step 2: 并行搜索所有集合
  // Promise.all 保证最大并发度，每个集合独立处理、互不影响
  const resultsPerCollection = await Promise.all(
    collections.map((name) => searchCollection(name, embedding, perCollection)),
  );

  // Step 3: 合并所有集合的结果
  const combined = resultsPerCollection.flat();

  // Step 4: 按距离排序（升序，distance 越小越相似）
  // distance 缺失时使用 999 兜底（排在末尾，不影响有效结果）
  combined.sort((a, b) => (a.distance || 999) - (b.distance || 999));

  // Step 5: 截取前 topK 条作为最终召回结果
  const results = combined.slice(0, topK);

  // 记录检索分布情况，便于监控和调试
  const breakdown = resultsPerCollection.map((r, i) => `${collections[i]}=${r.length}`).join(' ');
  logger.debug(`多集合检索: ${breakdown} → 合并取 ${results.length}`);
  return results;
}

/**
 * 向指定 collection 批量写入文档及其 embedding 向量。
 *
 * 这是 RAG 管道的**写入入口**，用于将知识库文档持久化到 ChromaDB。
 * 调用方负责先生成 embedding，本方法仅负责存储。
 *
 * **输入契约**:
 * - `documents`: 文档列表，每个文档必须含 id（唯一标识）和 text（原始文本），metadata 可选
 * - `embeddings`: 与 documents 一一对应的 embedding 向量数组
 * - `collectionName`: 可选，不传则使用 `config.chroma.sampleCollection` 作为默认集合
 *
 * **输出契约**: 成功时无返回值（void），失败时异常会向上传播
 *
 * **幂等性**: 使用相同 id 重复写入会覆盖已有文档（ChromaDB 的 upsert 语义由 add 实现）
 * **集合创建**: 若目标集合不存在，由 `getOrCreateCollection` 自动创建（余弦距离度量）
 *
 * @param documents - 待写入的文档列表
 * @param documents[].id - 文档唯一标识符
 * @param documents[].text - 文档原始文本内容
 * @param documents[].metadata - 可选的元数据键值对（如来源、分类等）
 * @param embeddings - 与 documents 一一对应的 embedding 向量（二维数组）
 * @param collectionName - 目标 collection 名，默认 config.chroma.sampleCollection
 * @throws {Error} 当 ChromaDB 连接失败或写入操作失败时抛出
 */
export async function addDocuments(
  documents: { id: string; text: string; metadata?: Record<string, unknown> }[],
  embeddings: number[][],
  collectionName?: string,
): Promise<void> {
  // 使用指定集合或默认采样集合
  const target = collectionName || config.chroma.sampleCollection;

  // 确保目标集合存在（幂等操作）
  const collection = await getOrCreateCollection(target);

  // 批量写入文档、元数据与 embedding 向量
  // ids/documents/metadatas/embeddings 按索引一一对应
  await collection.add({
    ids: documents.map((d) => d.id),
    documents: documents.map((d) => d.text),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadatas: documents.map((d) => d.metadata || {}) as any,
    embeddings,
  });

  logger.debug(`Chroma [${target}] 添加文档: ${documents.length} 条`);
}

export default { searchByEmbedding, addDocuments };
