import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * **requestLogger** — Express middleware that logs every incoming HTTP request.
 *
 * ## Where it's used in the chain
 *
 * This middleware is intended to be registered **early** in the Express middleware
 * stack (typically right after body parsers and before any route handlers) so
 * that it can observe the full lifecycle of every request flowing through the
 * app.  Because it hooks the response `'finish'` event it will fire regardless
 * of whether a request succeeds, is rejected by a guard, or throws an uncaught
 * error (as long as the response is eventually sent).
 *
 * ## What it logs
 *
 * | Field          | Source            | Example                |
 * | -------------- | ----------------- | ---------------------- |
 * | HTTP method    | `req.method`      | `GET` / `POST` / `PUT` |
 * | Request path   | `req.path`        | `/api/users/:id`       |
 * | Response code  | `res.statusCode`  | `200` / `401` / `500`  |
 * | Duration (ms)  | `Date.now()` diff | `42`                   |
 *
 * ## Edge cases / error scenarios
 *
 * - **Client disconnects before the response finishes** — the `'finish'` event
 *   will still fire when the underlying socket is closed, so the log entry
 *   captures whatever status code was set (or the default `200` if none was
 *   explicitly set before the disconnect).
 * - **Long-running requests (streaming, SSE, file uploads)** — the duration
 *   measured is wall-clock time from when the middleware runs until the response
 *   stream is fully finished, which may be significantly longer than the
 *   time-to-first-byte.  This is intentional so operators can spot slow
 *   responders at a glance.
 * - **Middleware order matters** — if placed *after* a middleware that calls
 *   `res.send()` or `res.end()` and does not call `next()`, this logger will
 *   never execute for that request.  Always keep it near the top of the stack.
 *
 * @param req  - Express Request object (provides `method` and `path`).
 * @param res  - Express Response object (listened for `finish`, provides `statusCode`).
 * @param next - Callback to hand control to the next middleware / route handler.
 * @returns    void — always calls `next()` to continue the chain.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  // Record the instant the request enters this middleware so we can compute
  // the total wall-clock duration once the response is fully sent.
  const start = Date.now();

  // The 'finish' event is emitted by the underlying http.ServerResponse when
  // the response has been handed off to the OS socket.  At that point headers
  // have been written and the status code is final, so we can log an
  // accurate summary line.
  res.on('finish', () => {
    // Compute wall-clock duration in milliseconds.
    const duration = Date.now() - start;

    // Log a single compact line per request.
    // Example: GET /api/health → 200 (12ms)
    logger.info(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });

  // Pass control to the next handler immediately.  The actual logging happens
  // asynchronously when the response finishes.
  next();
}
