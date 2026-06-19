/**
 * @fileoverview Express application factory —— the server's central assembly point.
 *
 * ## Role in the server lifecycle
 *
 * This module is **not** the entry point that listens on a port.  It exports
 * `createApp()`, a pure factory that builds, wires, and returns a fully
 * configured Express `Application`.  The actual entry point (e.g. `server.ts`
 * or `index.ts`) imports this function, calls it once, and then calls
 * `app.listen()`.
 *
 * Separating construction from listening keeps the app testable (supertest can
 * import `createApp` without binding a port) and makes the startup sequence
 * explicit:
 *
 *   1. Configuration loaded (via `./config/index.js` → dotenv + env vars).
 *   2. `createApp()` assembles the middleware chain and route tree.
 *   3. Caller attaches error listeners and starts listening on `config.port`.
 *
 * ## Middleware chain (order matters)
 *
 *   - **CORS** — permissive regex-based origin allowlist for local/dev use.
 *   - **Body parsing** — JSON only, capped at 1 MB to harden against
 *     oversized payloads.
 *   - **Request logger** — logs `METHOD /path → status (duration)` on every
 *     response `finish` event.
 *   - **Static files** — serves the uploads directory under `/uploads`.
 *   - **Route handlers** — health, upload, chat, growth, play.
 *   - **Global error handler** — catches synchronous throws, rejected
 *     promises, and `next(err)` calls from any upstream middleware/route.
 *
 * ## Configuration keys consumed from `config`
 *
 * | Key                | Env override              | Default                  | Purpose |
 * |--------------------|---------------------------|--------------------------|---------|
 * | `config.port`      | `PORT`                    | `3001`                   | HTTP listen port. |
 * | `config.deepseek.apiKey` | `DEEPSEEK_API_KEY`  | _(required)_             | API key for the DeepSeek LLM provider. |
 * | `config.deepseek.baseUrl`| `DEEPSEEK_BASE_URL`  | `https://api.deepseek.com/v1` | Base URL for DeepSeek API calls. |
 * | `config.deepseek.model`  | `DEEPSEEK_MODEL`     | `deepseek-chat`          | Model ID sent in chat-completion requests. |
 * | `config.ollama.baseUrl`  | `OLLAMA_BASE_URL`    | `http://localhost:11434` | Ollama server for local embeddings. |
 * | `config.ollama.embedModel`|`OLLAMA_EMBED_MODEL`  | `bge-m3`                 | Embedding model name used by Ollama. |
 * | `config.chroma.url`      | `CHROMA_URL`         | `http://localhost:8000`  | ChromaDB vector-database endpoint. |
 * | `config.chroma.searchCollections` | _(none)_     | `['rag_samples','rag_medical']` | Collections queried during RAG parenting lookups. |
 * | `config.chroma.collectionName` | `CHROMA_COLLECTION` or `CHROMA_COLLECTION_NAME` | `rag_docs` | Legacy single-collection fallback. |
 * | `config.rag.rerankTopK`  | `RERANK_TOP_K`       | `4`                      | Number of documents kept after reranking. |
 * | `config.rag.vectorSearchTopK` | `VECTOR_SEARCH_TOP_K` | `10`                | Candidate count from the vector index. |
 * | `config.rag.chatHistoryRounds`| `CHAT_HISTORY_ROUNDS`| `8`                      | Recent Q&A rounds included in the LLM context. |
 * | `config.rag.queryRewriteEnabled`| `QUERY_REWRITE_ENABLED` | `true`            | Toggle for query-rewriting before RAG retrieval. |
 * | `config.rag.rerankerUrl`  | `RERANKER_URL`       | _(empty)_                | External reranker service; uses DeepSeek when unset. |
 * | `config.upload.dir`       | `UPLOAD_DIR`         | `./uploads`              | Directory for uploaded files served via `/uploads`. |
 * | `config.upload.maxFileSizeMB`|`MAX_FILE_SIZE_MB`  | `10`                     | Max upload size in megabytes. |
 *
 * ## Error handling strategy
 *
 * - **`AppError`** (from middleware) carries an HTTP status code and a
 *   machine-readable `code` string.  The global handler serialises it as
 *   `{ error, code }`.
 * - **Multer `File too large`** is detected by message substring and mapped
 *   to `413 FILE_TOO_LARGE`.
 * - **Unknown errors** become `500 INTERNAL_ERROR`.  Stack traces are logged
 *   but only included in the response body when `NODE_ENV` is not
 *   `"production"`.
 * - **SSE / streaming safety**: if `res.headersSent` is true the handler
 *   logs a warning and returns immediately — it cannot send an error response
 *   because the HTTP head has already been flushed.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatRouter } from './routes/chat.js';
import { uploadRouter } from './routes/upload.js';
import { healthRouter } from './routes/health.js';
import { growthRouter } from './routes/growth.js';
import { playRouter } from './routes/play.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { config } from './config/index.js';

/**
 * __dirname equivalent for ESM modules.
 *
 * Computed once at module-load time from `import.meta.url` so that all
 * path-joining below uses the directory containing *this source file*,
 * regardless of the caller's CWD.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build and return a fully configured Express application.
 *
 * This is the single exported factory.  Callers should invoke it **once**
 * and then listen on the returned app:
 *
 * ```ts
 * import { createApp } from './app.js';
 * const app = createApp();
 * app.listen(config.port, () => { … });
 * ```
 *
 * @returns A wired Express `Application` ready to listen or be passed to
 *          supertest / other HTTP test runners.
 */
export function createApp() {
  const app = express();

  // ---- CORS ---------------------------------------------------------------
  // Allow-listed origins for local development:
  //   - localhost on any port (e.g. Vite dev server, React Native Expo)
  //   - 192.168.*.*  (LAN, common when testing from a phone/tablet)
  //   - 10.*.*.*     (corporate / VPN LANs)
  // Credentials are enabled so browsers will send cookies / auth headers.
  // This is intentionally permissive — tighten before deploying to production.
  app.use(cors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/192\.168\.\d+\.\d+:\d+$/, /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/],
    credentials: true,
  }));

  // ---- Body parsing -------------------------------------------------------
  // Only JSON bodies are accepted.  The 1 MB limit serves as a basic
  // denial-of-service guard — oversized payloads are rejected before they
  // reach route handlers or downstream services (LLM, vector DB, etc.).
  app.use(express.json({ limit: '1mb' }));

  // ---- Request logging ----------------------------------------------------
  // Hooks into the response `finish` event so the log line includes the
  // final status code and elapsed wall-clock time.
  app.use(requestLogger);

  // ---- Static files -------------------------------------------------------
  // User-uploaded files (avatars, attachments, etc.) are served directly
  // from the configured upload directory.  The directory is resolved
  // relative to the project root (one level above `src/`).
  app.use('/uploads', express.static(path.join(__dirname, '..', config.upload.dir)));

  // ---- Route handlers -----------------------------------------------------
  // Each router encapsulates a vertical slice of the API surface:
  //   /api/health   — liveness / readiness probes
  //   /api/upload   — file upload endpoint (backed by Multer)
  //   /api/chat     — LLM chat-completion with RAG-augmented parenting context
  //   /api/growth   — child growth curve queries
  //   /api/play     — parent-child activity / game suggestions
  app.use('/api/health', healthRouter);
  app.use('/api/upload', uploadRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/growth', growthRouter);
  app.use('/api/play', playRouter);

  // ---- Global error handler -----------------------------------------------
  // Must be registered **last** so it catches errors forwarded via
  // `next(err)` from any upstream middleware or route.
  // Handles AppError (typed), Multer file-too-large, and generic 500s.
  // Respects `res.headersSent` to avoid crashing on SSE/stream errors.
  app.use(errorHandler);

  return app;
}
