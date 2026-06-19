/**
 * @file server/src/index.ts — Server Entry Point
 *
 * ## Role in the Server Lifecycle
 *
 * This is the **process entry point**. It is responsible for the following
 * phases, in order:
 *
 *  1. **Bootstrap** – Load environment variables (delegated to `config/`).
 *  2. **Assembly**  – Import the Express application factory (`createApp`) and
 *     instantiate the fully wired application (middleware, routes, error
 *     handlers).
 *  3. **Listen**    – Bind the HTTP server to the configured port with
 *     `SO_REUSEADDR` so the OS can immediately reuse the address after a
 *     restart, avoiding `TIME_WAIT` delays during development.
 *  4. **Warm-up**   – Kick off background pre-warming tasks (e.g. Reranker
 *     model download) that must not block the `listening` event.
 *  5. **Graceful Shutdown** – Trap `SIGINT` / `SIGTERM`, forcibly tear down
 *     all active connections (SSE streams, in-flight RAG requests), and exit
 *     immediately. There is no long-lived drain phase because this is a
 *     single-instance dev/lightweight server, not a cluster.
 *
 * ## Architecture Notes
 *
 * - **Express app**: created by `./app.js` which owns the full middleware
 *   chain (CORS, JSON parsing, rate limiting, routes, 404/500 handlers).
 * - **Config**: read once at import time from `./config/index.js`, which
 *   sources values from `../../.env` (project root) with per-key defaults.
 * - **Logging**: uses a shared winston (or pino) logger instance from
 *   `./utils/logger.js`. No `console.log` is used in production paths.
 * - **Reranker pre-warming**: the local cross-encoder is fetched/cached in the
 *   background so the first RAG chat request does not pay the download
 *   latency.
 *
 * @module index
 */

import http from 'http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import logger from './utils/logger.js';
import { prewarmReranker } from './services/rag/reranker.js';

/**
 * Fully wired Express application.
 *
 * Contains the entire middleware chain: CORS, JSON body parsing, rate
 * limiting, API routes (`/api/health`, `/api/chat`, `/api/upload`, …), and
 * the final 404 / 500 error handlers.  See {@link module:app} for details.
 */
const app = createApp();

/**
 * Raw Node HTTP server wrapping the Express app.
 *
 * We use `http.createServer` (instead of `app.listen`) so we can set
 * `SO_REUSEADDR` on the underlying socket.  This tells the OS to release the
 * port immediately on close, skipping the `TIME_WAIT` state that otherwise
 * blocks restarts for 30–120 s during development.
 */
const server = http.createServer(app);

/**
 * Fired once when the server begins accepting connections.
 *
 * Logs the URLs for the health-check, chat, and upload endpoints, then
 * initiates a **non-blocking** background pre-warm of the local Reranker
 * model so the first RAG request does not pay the download cost.
 */
server.on('listening', () => {
  logger.info(`🚀 育儿AI服务已启动: http://localhost:${config.port}`);
  logger.info(`📋 健康检查: http://localhost:${config.port}/api/health`);
  logger.info(`💬 聊天接口: POST http://localhost:${config.port}/api/chat`);
  logger.info(`📁 上传接口: POST http://localhost:${config.port}/api/upload`);
  logger.info('');
  logger.info('💡 按 Ctrl+C 停止服务');

  // Fire-and-forget: download/warm the local Reranker model in the
  // background.  Errors are logged internally by the service; they do not
  // crash the server.
  prewarmReranker();
});

/**
 * Fired when the server socket is fully closed.
 *
 * Confirms the port has been released back to the OS.  Together with
 * `SO_REUSEADDR`, this guarantees the next `npm run dev` can rebind
 * immediately.
 */
server.on('close', () => {
  logger.info('✅ 端口已释放');
});

/**
 * Start listening on the configured port.
 *
 * Port is read from `process.env.PORT` (default `3001`) by the config module.
 *
 * @see {@link module:config}
 */
server.listen(config.port);

/**
 * Perform an immediate (non-graceful) shutdown.
 *
 * ## Why not graceful?
 *
 * This is a single-instance dev/lightweight server.  A graceful drain (stop
 * accepting new connections, wait for in-flight requests to finish) would add
 * complexity for little benefit in this context.  Long-lived connections
 * (SSE, Reranker fetch) are force-terminated via `closeIdleConnections` and
 * `closeAllConnections`.
 *
 * ## Sequence
 *
 *  1. Force-close idle connections (Node ≥ 18.2).
 *  2. Force-close **all** connections (Node ≥ 18.2; may be a no-op on older
 *     runtimes — the `?.` guards that).
 *  3. `process.exit(0)` — stops the event loop immediately.
 *
 * @param signal - The POSIX signal name that triggered shutdown (e.g.
 *   `'SIGINT'`, `'SIGTERM'`).  Used only for the log line.
 */
function gracefulShutdown(signal: string) {
  logger.info(`\n收到 ${signal} 信号，正在关闭...`);

  // Force-destroy every active connection so the event loop can drain.
  // Without this, hanging SSE clients or in-flight fetch requests would keep
  // the process alive indefinitely.
  server.closeIdleConnections?.();
  (server as any).closeAllConnections?.();

  // Exit immediately.  There is no drain phase — we have already torn down
  // all connections, and any pending async work (log flush, DB writes) is
  // acceptable to lose in a dev context.
  process.exit(0);
}

// ----- Signal handlers -----
// Bind to SIGINT (Ctrl+C) and SIGTERM (systemd / Docker stop) so the process
// shuts down cleanly instead of being killed with extreme prejudice.

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
