/**
 * 全局错误处理中间件 (Global Error-Handling Middleware)
 *
 * 职责：
 * 1. 定义 `AppError` 类——携带 HTTP 状态码与业务错误码的结构化异常。
 * 2. 提供 Express 错误处理中间件 `errorHandler`，统一捕获下游中间件/路由抛出的所有错误，
 *    转换为一致的 JSON 错误响应。
 *
 * 在中间件链中的位置：
 * - 必须在所有路由注册 **之后** 通过 `app.use(errorHandler)` 挂载，Express 的四个参数
 *   `(err, req, res, next)` 签名使其自动被识别为错误处理中间件。
 * - 上游任何同步/异步抛出的错误、`next(err)` 传递的错误都会到达这里。
 *
 * 使用方式：
 * - 路由或服务层抛出 `new AppError(400, 'INVALID_INPUT', '参数缺失')`，本中间件会返回
 *   `{ error: '参数缺失', code: 'INVALID_INPUT' }` 及对应的 HTTP 状态码。
 * - 未被 `AppError` 包装的错误统一按 500 处理，并在生产环境隐藏内部细节。
 */

import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * 应用级结构化错误
 *
 * 区别于普通 `Error`：携带 `statusCode`（HTTP 状态码）和 `code`（业务错误码），
 * 使错误处理中间件可以精确控制返回给客户端的 HTTP 状态与机器可读的错误标识。
 *
 * @example
 * // 在路由或 service 中使用
 * throw new AppError(404, 'USER_NOT_FOUND', `用户 ${userId} 不存在`);
 *
 * @example
 * // 在中间件中捕获
 * if (err instanceof AppError) {
 *   res.status(err.statusCode).json({ error: err.message, code: err.code });
 * }
 */
export class AppError extends Error {
  /**
   * @param statusCode - HTTP 状态码，如 400 / 404 / 403 / 500
   * @param code       - 业务错误码（机器可读，如 `'INVALID_INPUT'`、`'USER_NOT_FOUND'`），
   *                     前端可根据此字段做分支逻辑
   * @param message    - 人类可读的错误描述，会直接返回给客户端（在 `AppError` 场景下不做脱敏）
   */
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Express 全局错误处理中间件
 *
 * 捕获链路中任一中间件/路由抛出的错误或通过 `next(err)` 传递的错误，
 * 统一格式化为 `{ error: string; code: string }` 的 JSON 响应。
 *
 * 处理优先级：
 * 1. 若响应头已发送（如 SSE 流中途出错），仅记录日志，不再尝试写响应。
 * 2. `AppError` 实例 → 按其携带的 statusCode 与 code 返回。
 * 3. Multer 文件过大 → 413 + `FILE_TOO_LARGE`。
 * 4. 其他未知错误 → 500 + `INTERNAL_ERROR`，非生产环境附带原始 message。
 *
 * @param err  - 下游抛出的错误对象
 * @param _req - Express Request（未使用，以下划线前缀标记）
 * @param res  - Express Response，用于发送 JSON 错误体
 * @param _next - Express next 函数（未使用，错误处理中间件通常不调用 next，避免继续传播）
 *
 * @returns 不返回值；通过 `res.status().json()` 终止请求-响应周期。
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // 避免响应已发送时再次发送（如 SSE 流中途出错）
  // 此时连接可能仍处于打开状态，再次 write 会抛出 ERR_HTTP_HEADERS_SENT
  if (res.headersSent) {
    logger.warn('响应头已发送，跳过错误处理:', err.message);
    return;
  }

  // —— AppError 分支：已知的业务错误，按设计的状态码和错误码返回 ——
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  // Multer 文件过大 —— 检查 multer 抛出的原生错误中的关键字
  // multer 的默认错误 message 形如 "File too large"，此处通过字符串包含判断
  if (err.message?.includes('File too large')) {
    res.status(413).json({
      error: '文件大小超过限制',
      code: 'FILE_TOO_LARGE',
    });
    return;
  }

  // —— 未知错误 / 未预期异常：统一按 500 内部服务器错误处理 ——

  // 记录完整错误到日志，便于排查
  logger.error('未捕获的错误:', err.message);
  // 仅在非生产环境输出堆栈，避免将敏感信息写入生产日志
  if (process.env.NODE_ENV !== 'production') {
    logger.error('堆栈:', err.stack);
  }

  // 返回给前端的信息（生产环境不暴露内部细节，防止信息泄漏）
  const message = process.env.NODE_ENV === 'production'
    ? '服务器内部错误'
    : `服务器内部错误: ${err.message}`;

  res.status(500).json({
    error: message,
    code: 'INTERNAL_ERROR',
  });
}
