/**
 * @fileoverview DeepSeek LLM 服务封装层
 *
 * ## 职责
 * 本模块是 DeepSeek LLM 的统一访问入口，封装了 OpenAI-compatible SDK 的调用细节，
 * 向业务层暴露两个核心能力：
 * 1. **非流式聊天** (`chat`) — 传入完整消息数组，等待完整响应后返回。
 * 2. **流式聊天** (`chatStream`) — 返回 AsyncGenerator，边生成边 yield 增量文本。
 *
 * ## 在架构中的位置
 *
 * ```
 * ┌─────────────────────────────────────────────────┐
 * │  路由层 (routes/)                                 │
 * │  chat.ts  growth.ts  play.ts                     │
 * │  ┌─────────────────────────────────────────────┐ │
 * │  │ 领域服务层 (services/)                       │ │
 * │  │ intentRouter.ts  rag/queryRewriter.ts        │ │
 * │  │ rag/reranker.ts                              │ │
 * │  │ ┌─────────────────────────────────────────┐  │ │
 * │  │ │  本模块 (deepseek.ts)                    │  │ │
 * │  │ │  ┌─────────────────────────────────────┐│  │ │
 * │  │ │  │    OpenAI SDK (openai npm)           ││  │ │
 * │  │ │  │    ↓ HTTPS                           ││  │ │
 * │  │ │  │    DeepSeek API                      ││  │ │
 * │  │ │  └─────────────────────────────────────┘│  │ │
 * │  │ └─────────────────────────────────────────┘  │ │
 * │  └─────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────┘
 * ```
 *
 * **调用方一览**：
 * | 调用方 | 使用的函数 | 用途 |
 * |---|---|---|
 * | `routes/chat.ts` | `chat`, `chatStream` | 主对话接口（流式/非流式两用） |
 * | `routes/growth.ts` | `chatStream` | 成长档案生成，流式输出给前端 |
 * | `routes/play.ts` | `chat`, `chatStream` | 故事生成，流式/非流式两用 |
 * | `services/intentRouter.ts` | `chat` | 意图识别，需要完整响应后路由 |
 * | `services/rag/queryRewriter.ts` | `chat` | 查询改写，改写结果需完整返回 |
 * | `services/rag/reranker.ts` | `chat` | 精排打分，需要完整排序结果 |
 *
 * ## 设计原则
 *
 * - **单一出口**：所有对 DeepSeek API 的调用必须经过本模块，禁止业务代码直接实例化
 *   OpenAI client。这样可以在统一位置做日志、超时、重试、链路追踪等横切关注点。
 *
 * - **配置集中**：SDK 初始化参数（apiKey, baseUrl）统一从 `config.deepseek` 读取，
 *   不允许硬编码或从别处读取环境变量。
 *
 * - **错误语义化**：将底层 HTTP 错误码 / 网络错误转换为中文错误信息，
 *   上层调用方不需要理解 HTTP 状态码即可给用户友好的错误提示。
 *
 * - **流式/非流式共享错误处理**：`chat` 和 `chatStream` 对 401/429/连接失败 的错误
 *   处理策略完全一致，保证行为可预测。
 *
 * ## 技术栈
 *
 * - **SDK**：`openai` npm 包（DeepSeek API 兼容 OpenAI 协议，baseURL 指向
 *   `https://api.deepseek.com/v1`）。
 * - **模型**：默认 `deepseek-chat`，可通过 `options.model` 或 `DEEPSEEK_MODEL` 环境
 *   变量覆盖。
 * - **超时**：30 秒（SDK 级 timeout），防止请求长时间挂起。
 * - **重试**：最多 1 次（SDK 级 maxRetries），遇到可重试状态码（如 429, 5xx）时由
 *   SDK 自动重试，降低偶发抖动影响。
 *
 * @module deepseek
 */

import OpenAI from 'openai';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// ============================================================================
// SDK Client 初始化
// ============================================================================

/**
 * OpenAI-compatible SDK 的全局单例 client。
 *
 * 使用 DeepSeek 的兼容端点（baseURL 指向 `https://api.deepseek.com/v1`），
 * 因此可以使用 `openai` npm 包的所有 chat completion 能力。
 *
 * 初始化参数：
 * - `apiKey`: 从 `config.deepseek.apiKey` 读取，由 `DEEPSEEK_API_KEY` 环境变量注入。
 * - `baseURL`: 从 `config.deepseek.baseUrl` 读取，默认 `https://api.deepseek.com/v1`。
 * - `timeout`: 30 秒，防止请求无响应时无限等待。若业务需要更长的生成时间，
 *   应由调用方在 `options.maxTokens` 层面间接控制。
 * - `maxRetries`: 1 次。SDK 在遇到 429 (Rate Limit) 或 5xx (Server Error) 时会
 *   自动重试，减少上层处理成本。超过重试次数后 SDK 会抛出原始错误，由本模块的
 *   catch 块统一转换为中文错误信息。
 */
const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseUrl,
  timeout: 30000, // 30 秒超时，避免请求无限挂起
  maxRetries: 1,  // 最多重试 1 次，由 SDK 处理临时性网络/服务抖动
});

// ============================================================================
// 公共类型定义
// ============================================================================

/**
 * 聊天消息对象。
 *
 * 遵循 OpenAI Chat Completion 的消息格式。每条消息包含一个角色标识和文本内容。
 * 调用方负责维护消息数组的轮次顺序：越早的消息排在越前面，
 * 最后一条消息通常是当前的用户输入。
 *
 * 注意：DeepSeek 的 `deepseek-chat` 模型不支持 `name` 字段和 `tool_calls`，
 * 因此本类型仅包含 `role` 和 `content` 两个字段。
 *
 * @example
 * ```ts
 * const messages: ChatMessage[] = [
 *   { role: 'system', content: '你是一个育儿助手。' },
 *   { role: 'user',   content: '宝宝发烧怎么办？' },
 * ];
 * ```
 */
export interface ChatMessage {
  /** 消息角色 */
  role: 'system' | 'user' | 'assistant';
  /** 消息文本内容 */
  content: string;
}

/**
 * 聊天请求的可选参数。
 *
 * 所有字段均为可选，未设置时使用内部默认值或 `config.deepseek` 中的全局配置。
 * 调用方可以按需覆盖 `temperature`、`maxTokens` 等参数以适应不同的生成场景
 * （例如：创意生成用高温，事实问答用低温）。
 *
 * @example
 * ```ts
 * // 创意场景：提高温度
 * await chat(messages, { temperature: 0.9 });
 *
 * // 事实场景：低温 + 限制输出长度
 * await chat(messages, { temperature: 0.3, maxTokens: 512 });
 *
 * // 流式场景
 * for await (const chunk of chatStream(messages, { stream: true })) { ... }
 * ```
 */
export interface ChatOptions {
  /**
   * 模型名称。
   *
   * 覆盖默认的 `config.deepseek.model`（通常为 `deepseek-chat`）。
   * 可选值参考 DeepSeek 官方文档，如 `deepseek-chat`、`deepseek-reasoner`。
   */
  model?: string;

  /**
   * 采样温度，范围 [0, 2]，默认 0.7。
   *
   * - 接近 0：输出更确定、一致，适合事实问答和分类任务。
   * - 接近 1+：输出更具创造性和多样性，适合故事生成和对话。
   */
  temperature?: number;

  /**
   * 最大输出 token 数。
   *
   * 默认 2048。设得太小可能导致回复被截断（finish_reason = 'length'），
   * 设得太大可能影响响应延迟。建议根据场景调整：
   * - 分类/改写任务：256-512
   * - 一般对话：1024-2048
   * - 长文生成：4096+
   */
  maxTokens?: number;

  /**
   * 是否启用流式输出。
   *
   * 仅在 `chatStream` 中生效（内部固定为 `true`），`chat` 函数内部固定为 `false`。
   * 调用方一般不需要手动设置此字段。
   */
  stream?: boolean;
}

// ============================================================================
// 内部常量
// ============================================================================

/**
 * 默认最大输出 token 数。
 *
 * 2048 是中文对话场景的一个合理平衡点：
 * - 足够回答大多数育儿咨询问题（通常 200-800 字）。
 * - 不会因生成过长而显著增加首 token 延迟。
 * - 在 deepseek-chat 的 8192 上下文窗口内留有足够的 prompt 空间。
 */
const DEFAULT_MAX_TOKENS = 2048;

// ============================================================================
// 非流式聊天
// ============================================================================

/**
 * 非流式聊天：发送消息数组，等待完整响应后返回。
 *
 * ## 数据流
 * ```
 * 调用方 (routes/ / services/)
 *   │  messages: ChatMessage[]
 *   │  options: ChatOptions (可选)
 *   ▼
 *  chat()
 *   │  ① 记录开始时间
 *   │  ② 映射消息格式 (ChatMessage → OpenAI Message)
 *   │  ③ 调用 client.chat.completions.create({ stream: false })
 *   │  ④ 提取 response.choices[0].message.content
 *   │  ⑤ 提取 response.usage.total_tokens
 *   │  ⑥ 记录 debug 日志（耗时 + token 数）
 *   │  ⑦ 返回 { content, totalTokens }
 *   ▼
 * 调用方
 * ```
 *
 * ## 适用场景
 * - **意图识别** (intentRouter)：需要完整 JSON 响应后才能解析路由目标。
 * - **查询改写** (queryRewriter)：改写结果需要完整文本后送入向量检索。
 * - **精排打分** (reranker)：需要完整排序列表后才能截取 topK。
 * - **非流式对话** (chat.ts 非 stream 模式)：前端不需要逐字展示时使用。
 *
 * ## 错误处理策略
 *
 * 本函数将底层错误分为三类，分别给出中文错误信息：
 *
 * | 错误条件 | 抛出的错误 message |
 * |---|---|
 * | HTTP 401 | `"DeepSeek API Key 无效，请检查 .env 配置"` |
 * | HTTP 429 | `"DeepSeek API 请求过于频繁，请稍后重试"` |
 * | 连接失败 (ECONNREFUSED/ETIMEDOUT/ECONNRESET) | `"DeepSeek API 连接失败，请检查网络"` |
 * | 其他错误 | `"AI 服务请求失败: <原始错误信息>"` |
 *
 * 注意：
 * - SDK 的 `maxRetries: 1` 会在抛出异常前自动处理临时性 429/5xx 错误，
 *   因此到达本函数 catch 块的错误是已经重试失败后的最终错误。
 * - 401 错误不会触发 SDK 重试（鉴权失败重试无意义），会直接进入 catch 块。
 *
 * @param messages - 对话消息数组，按时间顺序排列。系统提示词应放在数组首位。
 * @param options - 可选的聊天参数，覆盖默认的 model、temperature、maxTokens。
 * @returns 包含生成文本 (`content`) 和消耗 token 总数 (`totalTokens`) 的对象。
 *          `totalTokens` 在 SDK 未返回 usage 信息时默认为 0。
 *
 * @throws {Error} 鉴权失败时抛出，message 为 "DeepSeek API Key 无效，请检查 .env 配置"
 * @throws {Error} 限流时抛出，message 为 "DeepSeek API 请求过于频繁，请稍后重试"
 * @throws {Error} 网络连接失败时抛出，message 为 "DeepSeek API 连接失败，请检查网络"
 * @throws {Error} 其他未知错误时抛出，message 为 "AI 服务请求失败: <详情>"
 *
 * @example
 * ```ts
 * const { content, totalTokens } = await chat([
 *   { role: 'system', content: '你是育儿助手。' },
 *   { role: 'user', content: '宝宝一岁发烧怎么办？' },
 * ]);
 * console.log(content);       // "宝宝发烧时建议..."
 * console.log(totalTokens);   // 456
 * ```
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<{ content: string; totalTokens: number }> {
  // 记录请求开始时间，用于计算耗时并输出 debug 日志
  const startTime = Date.now();

  try {
    // 调用 OpenAI-compatible SDK 的非流式接口
    // - model: 优先使用调用方传入的模型名，否则使用全局配置的默认模型
    // - messages: 将 ChatMessage[] 映射为 OpenAI SDK 期望的 { role, content } 格式
    // - temperature: 默认 0.7（?? 运算符仅在 null/undefined 时使用默认值，
    //   因此 temperature: 0 不会被覆盖为 0.7——这是 ?? 和 || 的关键区别）
    // - max_tokens: 默认 2048
    // - stream: false（非流式，等待完整响应后返回）
    const response = await client.chat.completions.create({
      model: options.model || config.deepseek.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    });

    // 安全提取响应内容：使用 optional chaining 防止 choices 为空或 message 缺失
    const content = response.choices[0]?.message?.content || '';

    // 安全提取 token 用量：SDK 可能在某些异常情况下不返回 usage 字段
    const totalTokens = response.usage?.total_tokens || 0;

    // 记录 debug 级别日志，包含耗时和 token 数，用于性能监控和问题排查
    logger.debug(`DeepSeek 完成 (${Date.now() - startTime}ms, ${totalTokens} tokens)`);
    return { content, totalTokens };
  } catch (err: any) {
    // 记录请求耗时，帮助定位是慢请求还是快速失败
    const elapsed = Date.now() - startTime;
    logger.error(`DeepSeek 请求失败 (${elapsed}ms):`, err.message);

    // === 错误分类与中文语义化 ===
    // 按照错误类型逐层判断，将底层 HTTP 状态码 / Node.js 网络错误码
    // 映射为面向用户的中文错误信息。上层调用方可以直接向用户展示这些信息。

    // 401 Unauthorized — API Key 未配置、已过期或格式错误
    // SDK 不会对 401 进行重试（鉴权失败重试无意义）
    if (err.status === 401) {
      throw new Error('DeepSeek API Key 无效，请检查 .env 配置');
    }

    // 429 Too Many Requests — 超出速率限制
    // SDK 会先重试 1 次（maxRetries: 1）；如果仍然 429，才会进入此分支。
    // 此时意味着短时间内请求量确实超过了配额，需要业务层限流或排队。
    if (err.status === 429) {
      throw new Error('DeepSeek API 请求过于频繁，请稍后重试');
    }

    // 网络连接级别错误 — DNS 解析失败、TCP 连接被拒、超时、连接重置
    // 这些是 Node.js 层面的错误（err.code），不是 HTTP 状态码
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
      throw new Error('DeepSeek API 连接失败，请检查网络');
    }

    // 兜底：其他未分类的错误（如 400 Bad Request、500 Internal Server Error 等）
    // 保留原始错误信息以辅助排查，同时添加中文前缀便于识别来源
    throw new Error(`AI 服务请求失败: ${err.message || '未知错误'}`);
  }
}

// ============================================================================
// 流式聊天
// ============================================================================

/**
 * 流式聊天：返回 AsyncGenerator，边生成边 yield 增量文本 token。
 *
 * ## 数据流
 * ```
 * 调用方 (routes/chat.ts, routes/growth.ts, routes/play.ts)
 *   │  messages: ChatMessage[]
 *   │  options: ChatOptions (可选)
 *   ▼
 *  chatStream()
 *   │  ① 记录开始时间
 *   │  ② 映射消息格式
 *   │  ③ 调用 client.chat.completions.create({ stream: true })
 *   │     返回一个可异步迭代的 Stream 对象
 *   │  ④ for await (const chunk of stream):
 *   │     提取 chunk.choices[0].delta.content
 *   │     若 delta 非空 → yield delta
 *   │  ⑤ 流结束后记录 debug 日志
 *   ▼
 * 调用方 (for await...of)
 * ```
 *
 * ## 适用场景
 * - **主对话接口** (routes/chat.ts)：前端需要逐字展示 AI 回复（打字机效果）。
 * - **成长档案生成** (routes/growth.ts)：长文本生成，流式输出避免前端长时间等待。
 * - **故事生成** (routes/play.ts)：流式输出故事内容，提升用户体验。
 *
 * ## 流式输出的生命周期
 *
 * ```
 * 调用方 for await (const chunk of chatStream(messages))
 *   │
 *   ├─ SSE / Transfer-Encoding: chunked ──→ 浏览器逐字渲染
 *   │   yield "宝宝" → yield "发烧" → yield "时" → ...
 *   │
 *   ├─ 正常结束：循环退出，日志记录耗时
 *   │
 *   └─ 异常中断：catch 块捕获错误
 *       - 401/429/连接错误 → 转换为中文错误 throw
 *       - 其他错误 → 保留原始错误 throw（与 chat() 不同，
 *         chatStream 对其他错误不添加中文前缀，直接向上抛出，
 *         让调用方根据自身场景决定如何处理）
 * ```
 *
 * ## 与 chat() 的关键差异
 *
 * | 维度 | chat() | chatStream() |
 * |---|---|---|
 * | 返回类型 | `Promise<{content, totalTokens}>` | `AsyncGenerator<string>` |
 * | token 统计 | 返回 `totalTokens` | 不支持（流式响应无 usage） |
 * | 错误兜底 | 添加中文前缀：`AI 服务请求失败: ...` | 直接 throw 原始错误 |
 * | 适用场景 | 意图识别、查询改写、精排 | 前端流式对话、长文生成 |
 *
 * 注意：`chatStream` 对其他错误的处理策略（直接 throw err）与 `chat()` 不同。
 * 这是因为流式场景下，调用方通常需要在 SSE 连接中向浏览器发送错误事件，
 * 保留原始错误可以让调用方做更精细的错误分类和恢复。
 *
 * @param messages - 对话消息数组，按时间顺序排列。
 * @param options - 可选的聊天参数。注意 `stream` 字段在内部固定为 `true`，
 *                 调用方传入的 `stream` 值会被忽略。
 * @returns 一个 AsyncGenerator，每次 yield 一个增量文本片段（string）。
 *          当模型生成完毕时，generator 自然结束（done: true）。
 *
 * @throws {Error} 鉴权失败时抛出，message 为 "DeepSeek API Key 无效，请检查 .env 配置"
 * @throws {Error} 限流时抛出，message 为 "DeepSeek API 请求过于频繁，请稍后重试"
 * @throws {Error} 网络连接失败时抛出，message 为 "DeepSeek API 连接失败，请检查网络"
 * @throws {Error} 其他未知错误时 **直接抛出原始错误对象**，不做中文包装。
 *                 调用方需自行处理此类错误。
 *
 * @example
 * ```ts
 * // 在 Express 路由中流式输出给浏览器
 * for await (const chunk of chatStream([
 *   { role: 'system', content: '你是育儿助手。' },
 *   { role: 'user', content: '讲一个睡前故事。' },
 * ])) {
 *   res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
 * }
 * res.write('data: [DONE]\n\n');
 * res.end();
 * ```
 */
export async function* chatStream(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  // 记录请求开始时间
  const startTime = Date.now();

  try {
    // 调用 OpenAI-compatible SDK 的流式接口
    // 参数与 chat() 基本一致，区别在于 stream: true
    // SDK 返回一个可异步迭代的 Stream 对象，每个 chunk 包含一部分增量内容
    const stream = await client.chat.completions.create({
      model: options.model || config.deepseek.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true, // 开启流式模式，SDK 返回 SSE 流
    });

    // 逐块消费流式响应
    // 每个 chunk 可能包含：
    // - delta.content: 增量文本（也可能是空字符串或 null）
    // - finish_reason: 仅在最后一个 chunk 中存在（如 'stop', 'length'）
    // 仅在有实际文本内容时才 yield，过滤掉空 delta
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }

    // 流正常结束，记录耗时
    // 注意：流式模式下 SDK 不返回 usage 信息，因此无法统计 token 数
    logger.debug(`DeepSeek Stream 完成 (${Date.now() - startTime}ms)`);
  } catch (err: any) {
    // 记录失败耗时
    const elapsed = Date.now() - startTime;
    logger.error(`DeepSeek Stream 失败 (${elapsed}ms):`, err.message);

    // === 错误分类（与 chat() 策略相同） ===

    // 401 — API Key 无效，鉴权失败
    if (err.status === 401) {
      throw new Error('DeepSeek API Key 无效，请检查 .env 配置');
    }

    // 429 — 请求过于频繁，已超过 SDK 重试次数上限
    if (err.status === 429) {
      throw new Error('DeepSeek API 请求过于频繁，请稍后重试');
    }

    // 网络连接级别错误 — DNS、TCP、超时
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
      throw new Error('DeepSeek API 连接失败，请检查网络');
    }

    // 注意：与 chat() 不同，这里对未分类错误保留原始错误对象直接抛出。
    // 原因：流式场景的调用方（如 chat.ts 路由）需要通过 err.status / err.code
    // 做更细粒度的错误处理（例如向 SSE 连接发送特定 error 事件），
    // 包装成中文 message 会丢失这些元数据。
    throw err; // 保留原始错误，让上层处理
  }
}

/**
 * 默认导出：包含 chat 和 chatStream 两个函数的对象。
 *
 * 使用方式：
 * ```ts
 * import deepseekService from './services/deepseek.js';
 * await deepseekService.chat(messages);
 * ```
 *
 * 大多数调用方使用具名导入（`import { chat, chatStream } from ...`），
 * 默认导出主要用于需要整体注入或 mock 的场景。
 */
export default { chat, chatStream };
