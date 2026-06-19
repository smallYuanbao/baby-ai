/**
 * @fileoverview 服务端配置入口模块
 *
 * 本模块是 server 进程生命周期中**最先执行**的模块之一，负责：
 * 1. 解析项目根目录的 `.env` 文件，将环境变量注入 `process.env`。
 * 2. 聚合所有环境变量，构建并导出唯一的、冻结的（逻辑上）配置对象 `config`。
 * 3. 为每个配置项提供默认值，保证在未设置环境变量时服务仍可启动。
 *
 * 启动时序：
 * ```
 *  npm start / tsx server/src/index.ts
 *    → import { config } from './config/index.js'   ← 本模块
 *      → dotenv.config(...)   // 将 .env 加载到 process.env
 *      → 构建 config 对象     // 读取 process.env + 默认值
 *    → 创建 Express app
 *    → 注册中间件链
 *    → 连接外部依赖（Ollama, ChromaDB）
 *    → 注册路由
 *    → app.listen(config.port)
 * ```
 *
 * 设计原则：
 * - **单一来源**：所有配置通过本模块的 `config` 对象访问，禁止在业务代码中直接读取 `process.env`。
 * - **早期失败**：通过 `required()` 在启动阶段暴露缺失的关键环境变量，避免运行时静默出错。
 * - **环境无关**：开发、测试、生产环境的差异仅反映在 `.env` 文件中，代码逻辑不做环境判断。
 *
 * @module config
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// 启动阶段：加载 .env 文件
// ============================================================================
// 使用 ESM 的 import.meta.url 推导 __dirname，确保无论从哪个工作目录启动，
// 都能正确找到项目根目录下的 .env 文件。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenv.config 将 .env 中的键值对写入 process.env。
// 若 .env 文件不存在，dotenv 静默跳过 —— 此时所有 required() 调用将输出警告并使用空字符串。
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 读取必需的环境变量，缺失时输出警告并返回空字符串。
 *
 * 注意：此函数**不会抛出异常**。设计意图是在启动日志中一次性暴露所有缺失变量，
 * 而非逐个失败、反复重启。调用方（config 对象）应确保关键服务（如 DeepSeek）
 * 在 apiKey 为空时能在后续初始化阶段给出明确的错误信息。
 *
 * @param key - 环境变量名（如 `'DEEPSEEK_API_KEY'`）
 * @returns 环境变量的值，缺失时返回空字符串
 */
function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.warn(`[config] 缺少环境变量: ${key}，使用默认值`);
  }
  return value || '';
}

// ============================================================================
// 配置对象
// ============================================================================

/**
 * 全局配置对象。
 *
 * 所有配置项均支持通过环境变量覆盖其默认值，覆盖规则：
 * - 字符串：`process.env.KEY || 'default'`
 * - 数字：`parseInt(process.env.KEY || 'default', 10)`
 * - 布尔：`process.env.KEY !== 'false'`（即未设置时为 `true`）
 *
 * 使用示例：
 * ```ts
 * import { config } from './config/index.js';
 * const apiKey = config.deepseek.apiKey;
 * ```
 */
export const config = {
  // --------------------------------------------------------------------------
  // 服务器
  // --------------------------------------------------------------------------

  /**
   * HTTP 服务监听端口。
   *
   * @default 3001
   * @env PORT
   */
  port: parseInt(process.env.PORT || '3001', 10),

  // --------------------------------------------------------------------------
  // DeepSeek LLM
  // --------------------------------------------------------------------------

  deepseek: {
    /**
     * DeepSeek API 密钥（必需）。
     *
     * 未设置时服务仍会启动，但调用 DeepSeek 接口时会因鉴权失败而报错。
     *
     * @default ''  （无默认值，必须通过 .env / 环境变量提供）
     * @env DEEPSEEK_API_KEY
     */
    apiKey: required('DEEPSEEK_API_KEY'),

    /**
     * DeepSeek API 基础地址。
     *
     * @default 'https://api.deepseek.com/v1'
     * @env DEEPSEEK_BASE_URL
     */
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',

    /**
     * DeepSeek 模型名称。
     *
     * 可选值参考 DeepSeek 官方文档，常见如 `deepseek-chat`、`deepseek-reasoner`。
     *
     * @default 'deepseek-chat'
     * @env DEEPSEEK_MODEL
     */
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },

  // --------------------------------------------------------------------------
  // Ollama（本地嵌入模型 / 可选 LLM）
  // --------------------------------------------------------------------------

  ollama: {
    /**
     * Ollama 服务地址。
     *
     * 用于生成文本嵌入向量（embedding）。如需将 DeepSeek 替换为本地模型，
     * 也可通过本地址调用 Ollama 的 chat 接口。
     *
     * @default 'http://localhost:11434'
     * @env OLLAMA_BASE_URL
     */
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',

    /**
     * Ollama 嵌入模型名称。
     *
     * 该模型需已通过 `ollama pull` 下载到本地。
     * bge-m3 是 BAAI 发布的多语言嵌入模型，中文效果较好。
     *
     * @default 'bge-m3'
     * @env OLLAMA_EMBED_MODEL
     */
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'bge-m3',
  },

  // --------------------------------------------------------------------------
  // ChromaDB（向量数据库）
  // --------------------------------------------------------------------------

  chroma: {
    /**
     * ChromaDB 服务地址。
     *
     * @default 'http://localhost:8000'
     * @env CHROMA_URL
     */
    url: process.env.CHROMA_URL || 'http://localhost:8000',

    // RAG 育儿检索会同时搜索下面两个集合
    /**
     * RAG 检索时并行搜索的集合列表。
     *
     * 育儿场景需要同时检索 AI 生成的 few-shot 示例（rag_samples）
     * 和中文医疗对话数据集（rag_medical），两者合并后送入精排/重排。
     *
     * @default ['rag_samples', 'rag_medical']
     */
    searchCollections: ['rag_samples', 'rag_medical'],

    /**
     * AI 生成的 few-shot 示例集合名称。
     *
     * @default 'rag_samples'
     */
    sampleCollection: 'rag_samples',

    /**
     * 中文医疗对话数据集集合名称。
     *
     * @default 'rag_medical'
     */
    medicalCollection: 'rag_medical',

    /**
     * 简历数据集合名称。
     *
     * 注意：此集合不参与育儿检索（不在 searchCollections 中），
     * 仅供简历相关功能独立使用。
     *
     * @default 'rag_resume'
     */
    resumeCollection: 'rag_resume',

    // 兼容旧配置：优先使用 CHROMA_COLLECTION，其次 CHROMA_COLLECTION_NAME
    /**
     * 通用 ChromaDB 集合名称（兼容旧版配置）。
     *
     * 优先级：`CHROMA_COLLECTION` > `CHROMA_COLLECTION_NAME` > `'rag_docs'`。
     * 新代码应优先使用上述明确的集合名称。
     *
     * @default 'rag_docs'
     * @env CHROMA_COLLECTION, CHROMA_COLLECTION_NAME
     */
    collectionName: process.env.CHROMA_COLLECTION
      || process.env.CHROMA_COLLECTION_NAME
      || 'rag_docs',
  },

  // --------------------------------------------------------------------------
  // RAG（检索增强生成）
  // --------------------------------------------------------------------------

  rag: {
    /**
     * 精排/重排后保留的 Top-K 文档数。
     *
     * 向量检索召回 `vectorSearchTopK` 条候选，经 Reranker 精排后截取前 `rerankTopK` 条
     * 注入 LLM 上下文。
     *
     * @default 4
     * @env RERANK_TOP_K
     */
    rerankTopK: parseInt(process.env.RERANK_TOP_K || '4', 10),

    /**
     * 向量检索召回的候选文档数。
     *
     * 每个查询从 ChromaDB 中检索 `vectorSearchTopK` 条最相似文档，
     * 发送给 Reranker 进行精排。
     *
     * @default 10
     * @env VECTOR_SEARCH_TOP_K
     */
    vectorSearchTopK: parseInt(process.env.VECTOR_SEARCH_TOP_K || '10', 10),

    /**
     * 注入 LLM 上下文的历史对话轮数。
     *
     * 每「轮」包含一次用户提问和一次助手回复。设置过大可能超出模型上下文窗口。
     *
     * @default 8
     * @env CHAT_HISTORY_ROUNDS
     */
    chatHistoryRounds: parseInt(process.env.CHAT_HISTORY_ROUNDS || '8', 10),

    /**
     * 是否启用查询改写（Query Rewrite）。
     *
     * 开启后，系统会在检索前将用户口语化、多轮依赖的查询改写为独立的检索查询，
     * 提升召回质量。设置为 `'false'` 可关闭。
     *
     * @default true
     * @env QUERY_REWRITE_ENABLED
     */
    queryRewriteEnabled: process.env.QUERY_REWRITE_ENABLED !== 'false',

    /**
     * 独立 Reranker 服务地址（可选）。
     *
     * 若为空字符串，则回退使用 DeepSeek 进行精排（通过 LLM 打分）。
     * 若配置了自部署的 Reranker（如 bge-reranker），则可降低延迟和成本。
     *
     * @default ''
     * @env RERANKER_URL
     */
    rerankerUrl: process.env.RERANKER_URL || '',
  },

  // --------------------------------------------------------------------------
  // 文件上传
  // --------------------------------------------------------------------------

  upload: {
    /**
     * 上传文件存储目录。
     *
     * 支持相对路径（相对于 server 进程的 cwd）或绝对路径。
     * 目录会在首次上传时自动创建（通过 multer 或 fs.mkdir）。
     *
     * @default './uploads'
     * @env UPLOAD_DIR
     */
    dir: process.env.UPLOAD_DIR || './uploads',

    /**
     * 单个上传文件的大小上限（MB）。
     *
     * 超过此限制的文件会被 multer 拒绝，返回 413 错误。
     *
     * @default 10
     * @env MAX_FILE_SIZE_MB
     */
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10),
  },
};
