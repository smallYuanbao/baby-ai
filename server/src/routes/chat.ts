/**
 * Chat Route — main conversational endpoint for the Baby AI server.
 *
 * Defines a single POST / handler that:
 *   - Validates the request body against {@link ChatRequestSchema}.
 *   - Optionally attaches uploaded file content to the user's message.
 *   - Trims conversation history to a configurable window.
 *   - Runs a RAG (Retrieval-Augmented Generation) pipeline for knowledge grounding.
 *   - Routes the user's intent to select the best system prompt.
 *   - Streams the assistant response via SSE (Server-Sent Events) when
 *     `req.query.stream !== 'false'`, otherwise returns a single JSON payload.
 *
 * Middleware chain (per-route):
 *   `validateBody(ChatRequestSchema)` → `async (req, res, next)`
 *
 * @module routes/chat
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { ChatRequestSchema } from '../types/chat.js';
import { validateBody } from '../middleware/validateBody.js';
import { runRAGPipeline } from '../services/rag/pipeline.js';
import { chat as deepseekChat, chatStream } from '../services/deepseek.js';
import { routeIntent } from '../services/intentRouter.js';
import {
  initSSE,
  sendToken,
  sendReferences,
  sendDone,
  sendError,
  sendStatus,
} from '../utils/sse.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export const chatRouter = Router();

/**
 * POST / — Main chat endpoint.
 *
 * Accepts a user message, optional conversation history, and an optional file
 * reference.  The endpoint runs a RAG pipeline to retrieve grounding context,
 * chooses a system prompt via intent routing, then calls the DeepSeek LLM.
 *
 * **Streaming mode** (default):
 *   Sets `Content-Type: text/event-stream` immediately so even early
 *   errors are delivered as SSE events rather than a generic HTTP error.
 *   The response sequence is:
 *     1. Optional `references` event (RAG citations)
 *     2. One or more `token` events (LLM output chunks)
 *     3. A final `done` event with a generated `messageId`
 *
 * **Non-streaming mode** (`?stream=false`):
 *   Returns a single JSON object containing the full answer, references, and
 *   token usage.
 *
 * @param {import('express').Request}  req  - Express request.
 *   @property {string}                req.body.message   - User's latest message (required per schema).
 *   @property {Array<{role:string,content:string}>} [req.body.history=[]]  - Prior conversation turns.
 *   @property {string}                [req.body.fileId]  - Uploaded file identifier for content extraction.
 *   @property {string}                [req.query.stream]   - Set to `"false"` to disable SSE streaming.
 * @param {import('express').Response} res  - Express response.
 * @param {import('express').NextFunction} next - Express next function (used for non-SSE errors).
 * @returns {void}  In streaming mode the response is flushed incrementally; in
 *                  non-streaming mode {@link res.json} is called once.
 *
 * @throws Will forward non-stream errors to Express error-handling middleware
 *         via `next(err)`.
 */
chatRouter.post('/', validateBody(ChatRequestSchema), async (req, res, next) => {
  // ---- 1. Extract request parameters ----
  // Destructure the validated body. `history` defaults to an empty array so
  // downstream code can safely call `.slice()` and iterate.
  const { message, history = [], fileId } = req.body;

  // Determine streaming mode from the query string.  Everything except an
  // explicit `?stream=false` is treated as streaming to match user expectation
  // (browsers and front-end clients typically want SSE).
  const stream = req.query.stream !== 'false';

  // ---- 2. SSE preamble: set headers before any async work so errors are delivered in-band ----
  // In SSE mode we must call `initSSE` *before* the first `await` inside the
  // try block.  If we waited, an early exception (e.g. RAG failure) would
  // reach the catch block and attempt to send SSE headers on an already-
  // partially-written or uninitialised response, confusing the client.
  if (stream) {
    initSSE(res);
  }

  try {
    // ---- 3. File attachment processing ----
    // When `fileId` is present we look up the physical file in the configured
    // upload directory, match it by its base name (ignoring extension), parse
    // its text content, and prepend it to the user's message so the LLM sees
    // the file content as conversational context.
    //
    // Edge cases handled:
    //   - File not found on disk → `matchedFile` is undefined; the original
    //     `message` is used unchanged.  The outer try/catch prevents a missing
    //     file from failing the whole request.
    //   - Parser returns text that starts with `[` (e.g. an error/info string
    //     like "[Unsupported format]") → the extracted text is discarded and
    //     the raw `message` is preserved.
    //   - Any exception during reading or parsing is caught, logged as a
    //     warning, and the request continues with the un-augmented `message`.
    let fullMessage = message;
    if (fileId) {
      try {
        const uploadDir = path.resolve(config.upload.dir);
        const files = await fs.readdir(uploadDir);
        // Match by the file's base name (before the first dot) so that
        // `fileId = "abc"` matches `abc.pdf` or `abc.txt`.
        const matchedFile = files.find((f) => f.startsWith(fileId.split('.')[0]));

        if (matchedFile) {
          const { fileParser } = await import('../services/fileParser.js');
          const filePath = path.join(uploadDir, matchedFile);
          const ext = path.extname(matchedFile).toLowerCase();
          // Map file extensions to IANA media types recognised by the parser.
          const mimeMap: Record<string, string> = {
            '.txt': 'text/plain', '.pdf': 'application/pdf',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          };
          const mimeType = mimeMap[ext] || 'text/plain';
          const extractedText = await fileParser.extract(filePath, mimeType);
          // Only augment the message when extraction returned meaningful text.
          if (extractedText && !extractedText.startsWith('[')) {
            fullMessage = `用户上传了一个文件，内容如下：\n${extractedText}\n\n用户问题：${message}`;
          }
        }
      } catch (err) {
        // Non-fatal: a broken file should not crash the chat request.
        logger.warn('读取上传文件失败:', err);
      }
    }

    // ---- 4. History windowing ----
    // Limit conversation history to the most recent N rounds (where one round
    // = one user turn + one assistant turn, hence `* 2` messages).  This
    // keeps the prompt within the model's context window and reduces token
    // costs while preserving the most relevant short-term context.
    const maxRounds = config.rag.chatHistoryRounds;
    const recentHistory = history.slice(-maxRounds * 2);

    // ---- 5. RAG Pipeline (retrieval-augmented generation) ----
    // Retrieves grounding documents / knowledge-base entries relevant to the
    // user's query.  The result may contain:
    //   - `context`: a text block to inject into the LLM prompt
    //   - `references`: an array of citation objects sent to the client
    // In streaming mode the client is notified that searching is in progress.
    if (stream) sendStatus(res, 'searching');
    const ragResult = await runRAGPipeline(fullMessage, recentHistory);
    if (stream) sendStatus(res, 'generating');

    // ---- 6. Intent routing ----
    // Classify the user's query into an intent category (e.g. 'general',
    // 'code', 'medical') and select the most appropriate system prompt.
    // This is purely a prompt-engineering step and does not change the
    // downstream model or API call.
    const intentResult = await routeIntent(fullMessage);
    if (intentResult.intent !== 'general') {
      logger.debug(`意图路由: ${intentResult.intent} (来源: ${intentResult.source})`);
    }

    // ---- 7. Build the LLM message array ----
    // The message order matters for most chat models:
    //   1. System prompt (from intent routing)
    //   2. Recent conversation history (user ↔ assistant turns)
    //   3. Current user message, optionally prefixed with RAG context
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: intentResult.prompt },
    ];

    // Replay recent history to give the model conversational continuity.
    for (const h of recentHistory) {
      messages.push({ role: h.role, content: h.content });
    }

    // Prepend RAG context (if available) to the user's message so the model
    // can ground its answer in retrieved documents.
    const userContent = ragResult.context
      ? `${ragResult.context}\n\n用户问题：${fullMessage}`
      : fullMessage;
    messages.push({ role: 'user', content: userContent });

    // Generate a unique message ID for this response.  The client can use it
    // for deduplication, threading, or feedback collection.
    const messageId = uuidv4();

    if (stream) {
      // ===== 8a. SSE streaming response =====
      // Sequence:
      //   1. Send RAG references (citations) if any were found.
      //   2. Stream LLM tokens one-by-one via `chatStream`.
      //   3. Send the `done` event with the message ID and close the stream.
      //
      // Error scenarios:
      //   - If `chatStream` throws mid-stream the outer catch block will call
      //     `sendError` on the already-initialised SSE response, so the
      //     front-end receives a structured error event instead of a broken
      //     connection.
      if (ragResult.references.length > 0) {
        sendReferences(res, ragResult.references);
      }

      for await (const chunk of chatStream(messages)) {
        sendToken(res, chunk);
      }

      sendDone(res, messageId, 0);
      res.end();
    } else {
      // ===== 8b. Non-streaming JSON response =====
      // Wait for the full model response, then return everything in one JSON
      // payload.  This is simpler for clients that cannot consume SSE.
      const { content, totalTokens } = await deepseekChat(messages);
      res.json({ messageId, content, references: ragResult.references, totalTokens });
    }
  } catch (err: any) {
    // ---- 9. Unified error handling ----
    // The error path branches on the response mode:
    //
    //   Streaming (SSE):
    //     Headers were already sent by `initSSE`.  We push an `error` SSE
    //     event so the front-end can surface the error immediately, then close
    //     the response.  Calling `next(err)` here would attempt to send a
    //     second HTTP status, which Express would reject with
    //     "ERR_HTTP_HEADERS_SENT".
    //
    //   Non-streaming:
    //     No headers have been sent yet, so we delegate to the standard
    //     Express error-handling middleware (e.g. the global error handler in
    //     app.ts).  This allows a consistent JSON error shape for REST
    //     consumers.
    logger.error('Chat 接口错误:', err.message);

    if (stream) {
      // SSE mode: deliver the error in-band as an SSE event.
      sendError(res, 'CHAT_ERROR', err.message || '服务暂时不可用，请稍后重试');
      res.end();
    } else {
      // Non-streaming: use Express's error propagation.
      next(err);
    }
  }
});
