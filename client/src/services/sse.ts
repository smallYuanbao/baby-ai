/**
 * @fileoverview SSE (Server-Sent Events) 流式数据消费服务
 *
 * 本文件提供基于 fetch API + ReadableStream 的 SSE 事件解析与消费能力。
 * 与传统 EventSource 不同，本实现支持 POST 请求，适用于需要请求体传递
 * 参数的 AI 对话场景（如发送对话历史、模型参数等）。
 *
 * 核心流程：
 *   1. 通过 fetch 发起请求，获取 Response 对象
 *   2. 使用 ReadableStream 逐块读取响应体
 *   3. 按 SSE 协议标准（\n\n 分隔事件）分割原始文本
 *   4. 逐事件解析 event/data 字段，以 AsyncGenerator 形式产出
 *
 * @see {@link ../types/chat.ts} SSEEvent 类型定义
 */

import type { SSEEvent } from '../types/chat';

/**
 * 解析 SSE 原始文本（单条事件块，以 \n\n 分隔后的一个片段）
 *
 * SSE 协议中每条事件由多个字段行组成，字段行以 key: value 格式编码，
 * 字段行之间以 \n（LF）分隔，事件之间以双换行 \n\n 分隔。
 * 本函数处理的是已经按 \n\n 切分后的单个事件文本块。
 *
 * @param raw - 单条 SSE 事件的原始文本，可能包含 event、data 等字段行
 * @returns 解析后的 SSEEvent 对象；若 data 字段为空则返回 null（空事件/心跳包）
 *
 * @example
 * // 标准 data 事件
 * parseSSEEvent('data: {"key":"value"}')
 * // => { event: 'message', data: { key: 'value' } }
 *
 * @example
 * // 自定义 event 类型
 * parseSSEEvent('event: done\ndata: [DONE]')
 * // => { event: 'done', data: '[DONE]' }
 *
 * @example
 * // 心跳包 / 注释行 —— 无 data 字段
 * parseSSEEvent(': heartbeat')
 * // => null
 */
function parseSSEEvent(raw: string): SSEEvent | null {
  const lines = raw.split('\n');
  // SSE 默认事件类型为 'message'（与浏览器 EventSource 行为一致）
  let event = 'message';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      // 提取 "event: " 之后的内容（前缀长度为 7 个字符）
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      // 提取 "data: " 之后的内容（前缀长度为 6 个字符）
      // 注意：此处保留原始空白（不去 trim），因为 JSON 解析前 trim 无意义，
      // 且对于非 JSON 数据，保留原始格式更为安全
      data = line.slice(6);
    }
    // 忽略其他 SSE 字段（id、retry、以冒号开头的注释行等）
  }

  // 没有 data 字段的事件视为无效（如仅含注释行的心跳包、空事件分隔符）
  if (!data) return null;

  // 尝试将 data 解析为 JSON；若失败则保留原始字符串
  // 这兼容了两种常见的 SSE data 格式：
  //   - JSON 对象/数组（AI API 响应）
  //   - 纯文本或特殊标记（如 OpenAI 的 "[DONE]"）
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

/**
 * 使用 fetch + ReadableStream 消费 SSE 流，以 AsyncGenerator 形式产出事件
 *
 * 与浏览器原生 EventSource API 的关键区别：
 *   - 支持 POST 请求（EventSource 仅支持 GET）
 *   - 调用方通过 fetch 发起请求后将 Response 传入，完全控制请求头、请求体等
 *   - 异步生成器模式使消费端可以用 for await...of 逐事件处理，代码结构清晰
 *
 * @param response - fetch 请求返回的 Response 对象
 *   前置条件：response.ok 为 true 且 response.body 非 null
 *   —— 通常在传入前由调用方检查，本函数内部做防御性二次校验
 *
 * @returns AsyncGenerator<SSEEvent> - 异步生成器，每次 yield 一条解析后的 SSE 事件
 *
 * @throws {Error} 当 response.ok 为 false 时抛出，携带 HTTP 状态码与响应体文本
 * @throws {Error} 当 response.body 为 null 时抛出（如响应已完成或使用了不支持的传输方式）
 *
 * @example
 * // 基本用法
 * const response = await fetch('/api/chat', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ messages: [...] }),
 * });
 * for await (const event of consumeSSEStream(response)) {
 *   console.log(event.event, event.data);
 * }
 *
 * @example
 * // 配合超时控制使用
 * const response = await fetch('/api/chat', { method: 'POST', ... });
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 30000);
 * for await (const event of consumeSSEStream(response)) {
 *   // 处理每条事件...
 * }
 */
export async function* consumeSSEStream(
  response: Response,
): AsyncGenerator<SSEEvent> {
  // —— 响应状态校验 ——
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`请求失败 (${response.status}): ${errorText}`);
  }

  // 防御性检查：某些场景（如重定向、HEAD 请求）下 body 可能为 null
  if (!response.body) {
    throw new Error('响应没有 body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // —— 逐块读取流数据 ——
  while (true) {
    const { done, value } = await reader.read();
    if (done) break; // 流结束，退出循环进入尾处理

    // 以流模式解码：{ stream: true } 确保跨 chunk 的多字节字符（如 emoji、中文）
    // 不会因字节边界截断而产生乱码 —— TextDecoder 会缓存不完整的字节序列
    buffer += decoder.decode(value, { stream: true });

    // 按 SSE 协议标准的事件分隔符 \n\n 切分
    // 每个事件之间以双换行分隔（HTTP 换行为 \n）
    const parts = buffer.split('\n\n');

    // parts.pop() 弹出并保留最后一个片段：
    //   1. 若 buffer 以 \n\n 结尾 → 最后一个元素是 ''，pop 返回 ''，buffer 设为 ''（正确）
    //   2. 若 buffer 不以 \n\n 结尾 → 最后一个元素是不完整事件，pop 保留到下次循环
    // 这确保跨 chunk 的半个事件不会丢失
    buffer = parts.pop() || '';

    for (const part of parts) {
      if (part.trim()) {
        const event = parseSSEEvent(part.trim());
        if (event) yield event;
      }
    }
  }

  // —— 流结束后处理缓冲区残留 ——
  // 理论上如果流正确结束，buffer 应为空或为一个完整事件的尾部
  // 这里做一次最终 drain，确保不丢失最后一个事件
  if (buffer.trim()) {
    const event = parseSSEEvent(buffer.trim());
    if (event) yield event;
  }
}
