import type { Response } from 'express';

/**
 * SSE (Server-Sent Events) 工具模块
 *
 * ## 职责
 * 本模块封装了 SSE 协议的核心操作，为整个服务端提供统一的实时流式推送能力。
 * 所有与 AI 对话流式响应相关的路由（如聊天接口、Agent 执行接口）均依赖此模块
 * 将 token 增量、参考来源、状态变更、错误信息和完成信号推送给前端。
 *
 * ## 在架构中的角色
 * - 位于传输层（Transport Layer），是 Express 响应对象与 SSE 协议之间的适配器。
 * - 被 `chat.controller`、`agent.controller` 等控制器调用，将业务层的流式数据
 *   转换为符合 SSE 规范的 HTTP 响应。
 * - 前端通过 `EventSource` API 或 `fetch` + `ReadableStream` 消费这些事件，
 *   实现打字机效果、实时状态提示等交互。
 *
 * ## SSE 协议要点
 * - 响应头必须设置为 `text/event-stream`。
 * - 每条消息由一个或多个 `field: value` 行组成，以空行（`\n\n`）结尾。
 * - 支持的字段包括 `event`（事件类型）、`data`（载荷）、`id`、`retry`。
 * - 连接为长连接（keep-alive），服务端可随时推送数据。
 *
 * ## 事件类型约定
 * | 事件类型     | 用途                           | 载荷字段                     |
 * |-------------|-------------------------------|-----------------------------|
 * | `token`     | 单个文本增量（打字机效果）        | `{ text: string }`          |
 * | `references`| 检索到的参考来源列表             | `{ references: unknown[] }` |
 * | `status`    | 处理阶段变更（如"搜索中"）        | `{ stage: string }`         |
 * | `done`      | 流结束，携带消息 ID 与 token 统计 | `{ messageId, totalTokens }`|
 * | `error`     | 流内错误（非 HTTP 级别）          | `{ code: string, message }` |
 *
 * ## 使用示例
 * ```typescript
 * import { initSSE, sendToken, sendDone, sendError } from '@/utils/sse';
 *
 * router.post('/chat', async (req, res) => {
 *   initSSE(res);
 *   try {
 *     for await (const chunk of llm.stream(req.body.messages)) {
 *       sendToken(res, chunk);
 *     }
 *     sendDone(res, messageId, totalTokens);
 *   } catch (err) {
 *     sendError(res, 'STREAM_ERROR', err.message);
 *   } finally {
 *     res.end();
 *   }
 * });
 * ```
 *
 * @module sse
 */

/**
 * 初始化 SSE 响应头
 *
 * 设置必要的 HTTP 响应头以建立 SSE 长连接。必须在发送任何事件之前调用。
 *
 * 各响应头的作用：
 * - `Content-Type: text/event-stream` — 告知浏览器这是 SSE 流，触发
 *   `EventSource` 的 `onmessage` / `addEventListener` 回调。
 * - `Cache-Control: no-cache` — 禁止浏览器或中间代理缓存流内容。
 * - `Connection: keep-alive` — 保持 TCP 连接不断开，允许服务端持续推送。
 * - `X-Accel-Buffering: no` — 禁用 Nginx 反向代理的响应缓冲。
 *   如果 Nginx 缓冲了 SSE 流，客户端将收不到增量数据，直到缓冲区满或连接关闭。
 *   这是生产环境部署中常见的坑。
 *
 * `flushHeaders()` 确保响应头立即发送到客户端，而不是等待首个 `res.write()`。
 * 这避免了客户端在收到 200 状态码后等待过久才收到响应头的问题。
 *
 * @param res - Express 的 Response 对象，用于写入 HTTP 响应头
 * @throws 不会显式抛出异常，但如果连接已关闭或 `res` 处于无效状态，
 *         Node.js 底层可能抛出 `ERR_HTTP_HEADERS_SENT` 等错误
 */
export function initSSE(res: Response): void {
  // 设置 SSE 必需的 Content-Type
  res.setHeader('Content-Type', 'text/event-stream');
  // 禁止缓存，确保客户端始终获取最新数据
  res.setHeader('Cache-Control', 'no-cache');
  // 启用长连接
  res.setHeader('Connection', 'keep-alive');
  // 禁用 Nginx 代理缓冲，防止增量数据被延迟
  res.setHeader('X-Accel-Buffering', 'no');
  // 立即发送响应头，避免客户端等待
  res.flushHeaders();
}

/**
 * 发送一条 SSE 事件（底层方法）
 *
 * 按照 SSE 协议格式构造并写入一条事件。一条 SSE 消息由多行 `field: value`
 * 组成，以空行结尾。本方法写入 `event` 行和 `data` 行，后跟两个换行符
 * （一个结束 data 行，一个作为消息边界空行）。
 *
 * 数据通过 `JSON.stringify` 序列化，前端需使用 `JSON.parse` 还原。
 *
 * **输入/输出契约：**
 * - 输入：Express Response 对象 + 事件名字符串 + 任意可 JSON 序列化的数据
 * - 输出：向 HTTP 响应流写入一段 SSE 格式文本
 * - 副作用：修改 TCP 发送缓冲区状态
 *
 * @param res - Express 的 Response 对象，必须已调用 `initSSE()` 初始化
 * @param event - SSE 事件类型名称，用于前端 `addEventListener(event, ...)`
 * @param data - 事件载荷，将经过 `JSON.stringify` 序列化后放入 `data` 字段
 * @throws 如果 `data` 包含循环引用等不可序列化的值，`JSON.stringify` 会抛出
 *         `TypeError`（但不会在此函数内被捕获，需由调用方处理）
 */
export function sendSSEEvent(
  res: Response,
  event: string,
  data: unknown,
): void {
  // 构造 SSE 消息行：
  // event: <type>      — 指定事件类型
  // data: <json>       — 携带 JSON 序列化的载荷
  // \n                 — 结束 data 行
  // \n                 — 空行，表示一条消息的结束
  const lines = [
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ];
  // 将行数组用换行符拼接并写入响应流
  res.write(lines.join('\n'));
}

/**
 * 发送 token 增量文本块
 *
 * 用于流式对话场景：每收到一个 LLM token，就通过此函数实时推送给前端，
 * 实现打字机效果。`sendSSEEvent` 的便捷封装。
 *
 * **输入/输出契约：**
 * - 输入：一个文本字符串（通常为单个 token 或多个 token 组成的小块）
 * - 输出：一条 `event: token` 的 SSE 消息，载荷为 `{ text: string }`
 * - 前端对应事件：`eventSource.addEventListener('token', ...)`
 *
 * @param res - Express 的 Response 对象
 * @param text - LLM 生成的增量文本片段
 */
export function sendToken(res: Response, text: string): void {
  // 以 "token" 事件类型发送，载荷包含文本字段
  sendSSEEvent(res, 'token', { text });
}

/**
 * 发送检索参考来源
 *
 * 在 RAG（检索增强生成）流程中，检索阶段完成后将参考文档列表推送给前端，
 * 用于展示引用来源卡片或脚注。
 *
 * **RAG 管道中的位置：** Retrieval 阶段之后，Generation 阶段之前或并行。
 * 前端收到此事件后可立即渲染引用来源 UI，无需等待生成完成。
 *
 * **输入/输出契约：**
 * - 输入：参考来源数组，元素结构由上游 RAG 检索器定义
 * - 输出：一条 `event: references` 的 SSE 消息，载荷为 `{ references: unknown[] }`
 *
 * @param res - Express 的 Response 对象
 * @param references - 检索到的参考来源数组，每个元素通常包含 title、url、snippet 等字段
 */
export function sendReferences(res: Response, references: unknown[]): void {
  // 以 "references" 事件类型发送，载荷直接包含 references 数组
  sendSSEEvent(res, 'references', { references });
}

/**
 * 发送流完成信号
 *
 * 当 LLM 流式生成全部结束时调用，通知前端对话回复已完成。
 * 携带消息的唯一标识和 token 消耗统计，前端可据此更新消息状态、
 * 记录用量、关闭加载动画。
 *
 * **重要：** 调用此函数后不会自动结束响应。调用方仍需在合适的时机（如
 * `finally` 块中）调用 `res.end()` 来关闭 HTTP 连接，避免资源泄漏。
 *
 * **输入/输出契约：**
 * - 输入：消息 ID + token 消耗总数
 * - 输出：一条 `event: done` 的 SSE 消息，载荷为 `{ messageId, totalTokens }`
 * - 前端收到此事件后应将当前消息标记为"已完成"
 *
 * @param res - Express 的 Response 对象
 * @param messageId - 当前消息的唯一标识符，前端用于关联更新
 * @param totalTokens - 本次生成消耗的 token 总数（含提示词和补全）
 */
export function sendDone(res: Response, messageId: string, totalTokens: number): void {
  // 以 "done" 事件类型发送，包含消息 ID 和 token 统计
  sendSSEEvent(res, 'done', { messageId, totalTokens });
}

/**
 * 发送流内错误
 *
 * 当流式处理过程中发生可恢复的错误（非致命的 HTTP 500）时，通过此函数
 * 通知前端。与 HTTP 状态码不同，SSE 错误事件允许在同一个连接中先发错误，
 * 再继续推送数据或正常结束。
 *
 * **降级/容错策略：**
 * - 调用方应在 `try/catch` 中包装业务逻辑，捕获异常后调用此函数。
 * - 发送错误后应继续调用 `sendDone()` 或直接 `res.end()` 以正常关闭连接，
 *   避免前端 `EventSource` 触发自动重连（重连可能导致重复处理）。
 * - 如果错误是致命的（如连接断开），则无需调用此函数，直接 `res.end()`。
 *
 * **输入/输出契约：**
 * - 输入：错误码字符串 + 人类可读的错误描述
 * - 输出：一条 `event: error` 的 SSE 消息，载荷为 `{ code, message }`
 * - 前端根据 `code` 做逻辑判断（如 `RATE_LIMITED`），用 `message` 展示给用户
 *
 * @param res - Express 的 Response 对象
 * @param code - 机器可读的错误码，如 `STREAM_ERROR`、`RATE_LIMITED`、`TIMEOUT`
 * @param message - 人类可读的错误描述，用于前端展示
 */
export function sendError(res: Response, code: string, message: string): void {
  // 以 "error" 事件类型发送，包含错误码和描述信息
  sendSSEEvent(res, 'error', { code, message });
}

/**
 * 发送处理阶段状态变更
 *
 * 用于向用户反馈当前处理进度，如"正在检索知识库"、"正在生成回答"等。
 * 在多阶段 RAG 或 Agent 流水线中，此函数在阶段切换时调用，
 * 前端据此更新进度条、状态文本或 loading 动画。
 *
 * **典型使用场景：**
 * 1. 检索阶段 → `sendStatus(res, 'searching')`
 * 2. 重排序阶段 → `sendStatus(res, 'reranking')`
 * 3. 生成阶段 → `sendStatus(res, 'generating')`
 *
 * **输入/输出契约：**
 * - 输入：阶段标识字符串
 * - 输出：一条 `event: status` 的 SSE 消息，载荷为 `{ stage: string }`
 * - `stage` 值由调用方约定，前后端需保持一致
 *
 * @param res - Express 的 Response 对象
 * @param stage - 当前处理阶段的标识符，如 `'searching'`、`'generating'`
 */
export function sendStatus(res: Response, stage: string): void {
  // 以 "status" 事件类型发送，载荷包含阶段标识
  sendSSEEvent(res, 'status', { stage });
}
