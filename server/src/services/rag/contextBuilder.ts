/**
 * @fileoverview RAG 上下文构建器 —— 知识增强生成管线的**终段组装层**。
 *
 * ## 在架构中的角色
 *
 * 本模块处于 RAG 管道的最后一个阶段，负责将上游检索、重排序（reranking）后的文档列表
 * 转化为 LLM 可直接消费的**带引用标记的上下文提示词（context string）**和一份结构化的
 * **引用目录（references）**。它是 RAG 检索结果与 LLM 生成之间的**桥接层**。
 *
 * ## 管道位置
 *
 * ```
 * 用户问题
 *   → rewriteService.rewrite()       [查询重写]
 *   → searchService.search()         [向量检索]
 *   → rerankService.rerank()         [相关性重排序]
 *   → contextBuilder.buildContext()  ← 本模块（终段组装）
 *   → LLM 生成                        [带引用的回答]
 * ```
 *
 * ## 输入/输出契约
 *
 * - **输入**: `RAGDocument[]` —— 由重排序服务输出的有序文档列表，每个文档包含
 *   `id`、`text`、`metadata`（含 `title`/`source` 等可选字段）、`score`（0-1 相关性分数）。
 * - **输出**: `{ context: string; references: Reference[] }` ——
 *   `context` 是可注入 System Prompt 或 User Message 的提示词文本，内含 `[1]` `[2]` 等
 *   引用锚点；`references` 是对应引用锚点的结构化元数据，可随 SSE 流下发给前端渲染
 *   引用卡片。
 *
 * ## 设计原则
 *
 * 1. **防御性处理**: 对缺失的 `metadata.title`、`metadata.source`、`score` 均有 fallback，
 *    不会因数据不完整而抛出异常。
 * 2. **空输入安全**: 空文档列表返回 `{ context: '', references: [] }`，由上层决定是否
 *    降级为纯 LLM 回答（无知识增强）。
 * 3. **纯函数**: 不依赖外部服务、不产生副作用，输出仅由输入决定，便于测试和缓存。
 *
 * @module services/rag/contextBuilder
 */

import type { RAGDocument } from '../../types/rag.js';
import type { Reference } from '../../types/chat.js';

/**
 * RAG 上下文构建器
 *
 * ## 输入/输出契约
 *
 * 接收重排序后的 {@link RAGDocument} 列表，将其转换为两个产物：
 * 1. **context**（`string`）：一段包含引用标记 `[1]`、`[2]`... 的提示词文本，
 *    可注入到 LLM 的 System Prompt 或 User Message 中，指示模型基于参考资料作答。
 * 2. **references**（`Reference[]`）：引用目录数组，每个元素包含引用编号、标题、
 *    摘要片段和相关性分数，供前端在回答结束后渲染引用卡片。
 *
 * ## 算法步骤
 *
 * ```
 * 1. 空输入守卫 → 空集合直接返回空上下文和空引用列表
 * 2. 遍历文档列表（顺序即为重排序后的相关性顺序）：
 *    a. 分配引用编号（citationIndex = i + 1，从 1 开始）
 *    b. 提取标题：metadata.title → metadata.source → "参考文档 N"（三级 fallback）
 *    c. 截取摘要片段（前 150 字符，超出加 "..."）
 *    d. 构建带引用标记的文本块 "[N] 文档正文"
 *    e. 构建 Reference 对象
 * 3. 组装最终 context 字符串：前缀指令 + 文档块 + 后缀指令
 * 4. 返回 { context, references }
 * ```
 *
 * ## 降级/容错策略
 *
 * | 场景 | 行为 |
 * |------|------|
 * | `documents` 为空数组 | 返回空 context 和空 references，由上层判断是否降级为纯 LLM 回答 |
 * | `doc.metadata` 为 `undefined` | 等价于空对象，走 fallback 标题逻辑 |
 * | `metadata.title` 和 `metadata.source` 均缺失 | 标题降级为 `"参考文档 N"` |
 * | `doc.score` 为 `undefined` | 引用分数降级为 `0` |
 * | `doc.text` 为空字符串 | 片段为 `"..."`（`"".slice(0,150)` 返回 `""`，`"".length > 150` 为 false，不会追加省略号，最终 snippet 为 `""`） |
 *
 * @param documents - 重排序后的 RAG 文档列表，顺序即为相关性降序。数组可为空。
 * @returns 包含带引用标记的上下文文本和引用目录的对象。
 *   - `context` —— 可直接作为 LLM 输入一部分的完整提示词文本。
 *   - `references` —— 与 context 中的 `[N]` 标记一一对应的引用元数据数组。
 * @throws 不抛出异常 —— 所有边界情况均有防御性处理。
 *
 * @example
 * ```typescript
 * const { context, references } = buildContext(rerankedDocs);
 * // context: "以下是与用户问题相关的参考资料：\n\n[1] React 是一个用于构建用户界面的 JavaScript 库...\n\n请基于以上参考资料回答用户的问题..."
 * // references: [{ id: 1, title: "React 官方文档", snippet: "React 是一个...", score: 0.92 }]
 * ```
 */
export function buildContext(documents: RAGDocument[]): {
  context: string;
  references: Reference[];
} {
  // ---- 阶段 1: 空输入守卫 ----
  // 空文档列表意味着上游检索未命中任何相关文档。返回空上下文和空引用列表，
  // 由上层调用方决定降级策略（例如：不注入 RAG 上下文，由 LLM 自行回答）。
  if (documents.length === 0) {
    return {
      context: '',
      references: [],
    };
  }

  // ---- 阶段 2: 逐文档构建引用标记 ----
  // contextParts 存储带引用编号的文档全文块，references 存储对应的结构化元数据。
  // 两者的索引位置隐式对齐（都按 documents 的遍历顺序），但通过 citationIndex 显式编号。
  const contextParts: string[] = [];
  const references: Reference[] = [];

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    // 引用编号从 1 开始（人类可读），与 LLM 回答中的 [1]、[2] 标记对应
    const citationIndex = i + 1;

    // ---- 阶段 2a: 标题提取（三级 fallback） ----
    // 优先级：metadata.title → metadata.source → 默认名称 "参考文档 N"
    // 使用类型断言 `as string` 是因为 metadata 类型为 Record<string, unknown>，
    // 实际数据源会保证 title/source 为字符串。
    const title = (doc.metadata?.title as string)
      || (doc.metadata?.source as string)
      || `参考文档 ${citationIndex}`;

    // ---- 阶段 2b: 摘要片段截取 ----
    // 取文档正文前 150 个字符作为摘要，超长则追加省略号 "..."。
    // 此片段用于前端引用卡片的预览，不在 context 中展示（context 使用完整正文）。
    const snippet = doc.text.slice(0, 150) + (doc.text.length > 150 ? '...' : '');

    // ---- 阶段 2c: 上下文文本块 ----
    // 格式："[N] <文档全文>"，N 为引用编号。
    // 各文档块之间将由空行（\n\n）分隔，确保 LLM 能清晰区分不同参考资料。
    contextParts.push(`[${citationIndex}] ${doc.text}`);

    // ---- 阶段 2d: 引用对象 ----
    // 每个引用对象与 context 中的 [N] 通过 id 字段对应。
    // score 降级为 0：当上游服务未返回 score 时（如某些检索后端不计算分数），
    // 前端可据此隐藏分数展示或显示 "N/A"。
    references.push({
      id: citationIndex,
      title,
      snippet,
      score: doc.score || 0,
    });
  }

  // ---- 阶段 3: 最终上下文组装 ----
  // 构造一段完整的中文提示词，包含三个部分：
  //   (a) 前缀指令：告知 LLM 以下是参考资料
  //   (b) 文档块：用双空行分隔的带引用标记的文档全文
  //   (c) 后缀指令：要求 LLM 基于参考资料回答，并在回答中用 [N] 标记引用来源
  //
  // 提示词语言选择中文是因为目标用户为中文使用者，且参考资料也以中文为主。
  // 如果面向多语言场景，此处可抽取为可配置的模板。
  const context = [
    '以下是与用户问题相关的参考资料：',
    '',
    contextParts.join('\n\n'),
    '',
    '请基于以上参考资料回答用户的问题。在回答中用 [1]、[2] 等标记引用来源。',
  ].join('\n');

  return { context, references };
}
