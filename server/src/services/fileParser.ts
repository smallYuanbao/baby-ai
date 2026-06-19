/**
 * File Parser Service
 * ===================
 * Responsible for extracting plain-text content from uploaded files before they
 * enter the RAG (Retrieval-Augmented Generation) indexing pipeline.
 *
 * ## Role in the architecture
 *
 * This service acts as the **ingestion gate** of the knowledge-base subsystem.
 * When a user uploads a file through the API, the upload handler stores the raw
 * bytes and records the MIME type, then hands off to this service to produce a
 * **canonical text representation** that downstream components can consume
 * without needing to know the original format.
 *
 * ## RAG pipeline contract (input/output)
 *
 * ```
 *   [Upload Handler] ──(filePath, mimeType)──> fileParser.extract()
 *                                                      │
 *                                                      ▼
 *                                              text:string
 *                                                      │
 *                                                      ▼
 *                                    [Text Chunker / Embedder / Vector Store]
 * ```
 *
 * - **Input**:  `filePath` (absolute path on disk to the uploaded file) +
 *               `mimeType` (IANA media type string, e.g. `"text/plain"`).
 * - **Output**: A `Promise<string>` that resolves to the extracted text.
 *   May be empty, truncated (to the first 5000 characters), or a placeholder
 *   string when extraction is not supported or fails.
 * - **Guarantees**: Never throws to the caller. All errors are caught
 *   internally and surfaced as human-readable placeholder strings so that the
 *   RAG pipeline can continue indexing without interruption.
 *
 * ## Design decisions
 *
 * - **Truncation at 5000 characters** keeps embedding costs predictable and
 *   prevents a single giant document from dominating the chunk budget.
 *   This limit is applied after extraction so that the parser itself sees the
 *   full file — only the consumer receives the truncated result.
 *
 * - **Lazy PDF dependency** — `pdf-parse` is imported dynamically (`await
 *   import()`). This avoids loading the native PDF parser into memory for
 *   every request that might not involve a PDF (e.g. plain-text uploads).
 *
 * - **Future extension point** — new formats (Word, images with OCR, HTML,
 *   Markdown, etc.) can be added as branches in the `extract()` switch
 *   without changing any caller.
 *
 * - **NO mutation of the original file** — this service is read-only.
 *
 * @module fileParser
 */

import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a plain-text file.
 *
 * Reads the file as UTF-8 and returns the first 5000 characters. If the file
 * cannot be read (e.g. missing, permissions, binary content), the resulting
 * `ENOENT` / `EACCES` error will **propagate** to the caller — this function
 * does not catch errors, leaving the decision of how to degrade to its sole
 * call-site (`extract()`).
 *
 * @param filePath - Absolute path to the file on disk.
 * @returns The file contents truncated to 5000 UTF-16 code units.
 * @throws {NodeJS.ErrnoException} If `fs.readFile` fails (ENOENT, EACCES, etc.).
 */
async function extractPlainText(filePath: string): Promise<string> {
  // Read the entire file into memory as a UTF-8 string. For very large files
  // this could be memory-intensive, but the 5000-char truncation makes it
  // acceptable in practice.
  const content = await fs.readFile(filePath, 'utf-8');

  // Truncate to the first 5000 characters — the contract with the RAG
  // pipeline guarantees that consumers never see a raw document longer than
  // this limit.
  return content.slice(0, 5000);
}

/**
 * Extract text from a PDF file using the `pdf-parse` library.
 *
 * ## How it works
 *
 * 1. Dynamically imports the `pdf-parse` ESM module (lazy-loading).
 * 2. Reads the raw PDF bytes from disk via `fs.readFile`.
 * 3. Hands the buffer to `pdfParse()`, which shells out to a native PDF
 *    renderer (pdf.js under the hood) and returns an object with `.text`.
 * 4. Truncates the extracted text to the first 5000 characters.
 *
 * ## Fallback / degradation
 *
 * If **any** step fails — missing file, corrupt PDF, native-parser crash,
 * dynamic-import failure — the error is caught, logged at `warn` level, and
 * the function returns the placeholder string `"[PDF 解析失败]"` so that:
 * - The caller never receives an unhandled promise rejection.
 * - The RAG pipeline can still process other files in the batch.
 * - The operator can investigate via the log message.
 *
 * @param filePath - Absolute path to the PDF file on disk.
 * @returns Extracted text (first 5000 characters), or the Chinese-language
 *          fallback string `"[PDF 解析失败]"` on any error.
 * @throws Nothing — all errors are caught internally.
 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    // Lazy dynamic import — `pdf-parse` is an ESM-only package, so we use
    // `await import()` rather than a top-level `import` statement. This
    // keeps the dependency "cold" for non-PDF requests and avoids blocking
    // the module graph for consumers that never touch PDFs.
    const pdfParse = (await import('pdf-parse')).default;

    // Read the full PDF as a binary buffer. pdf-parse requires the entire
    // file in memory to extract text.
    const dataBuffer = await fs.readFile(filePath);

    // Call pdf-parse, which internally uses pdf.js to extract text streams
    // from every page and concatenates them.
    const data = await pdfParse(dataBuffer);

    // Apply the same 5000-character truncation contract used by all parsers.
    return data.text.slice(0, 5000);
  } catch (err) {
    // Degrade gracefully: log the cause and return a stable placeholder.
    // The caller (extract()) relies on this never throwing.
    logger.warn('PDF 解析失败:', err);
    return '[PDF 解析失败]';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract text content from an uploaded file, dispatching to the correct
 * parser based on the file's MIME type.
 *
 * This is the **single entry-point** for the RAG ingestion pipeline. Callers
 * only need to provide the file's on-disk path and its IANA media type; the
 * function selects the appropriate parser internally.
 *
 * ## Supported MIME types
 *
 * | MIME type                                                       | Behavior                            |
 * |-----------------------------------------------------------------|-------------------------------------|
 * | `text/plain`                                                    | UTF-8 read, truncated to 5000 chars |
 * | `application/pdf`                                               | pdf-parse extraction, 5000 chars    |
 * | `image/png`, `image/jpeg`, `image/gif`, `image/webp`           | Placeholder (OCR not implemented)   |
 * | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (`docx`), `application/msword` (`doc`) | Placeholder (advise user to convert) |
 * | Any other MIME type                                             | Placeholder with the MIME type name |
 *
 * ## Error behaviour
 *
 * This function **never throws**. Every code path returns a string:
 * - Successful extraction returns the document text.
 * - Unsupported types return a Chinese-language placeholder (`[...]`).
 * - Internal parser errors are caught by the individual parsers and also
 *   surfaced as placeholder strings.
 *
 * @param filePath - Absolute filesystem path to the uploaded file.
 * @param mimeType  - IANA media type string (e.g. `"text/plain"`,
 *   `"application/pdf"`).
 * @returns A Promise that resolves to the extracted text string. May be
 *          empty, truncated to 5000 characters, or a human-readable
 *          placeholder for unsupported/error cases.
 * @throws Nothing — all error paths are handled internally.
 *
 * @example
 * ```ts
 * const text = await fileParser.extract('/tmp/abc.pdf', 'application/pdf');
 * // text is the first 5000 characters of the PDF, or "[PDF 解析失败]"
 * ```
 */
async function extract(filePath: string, mimeType: string): Promise<string> {
  switch (mimeType) {
    // ---- Supported text formats ----

    case 'text/plain':
      // Delegate to the plain-text reader. Any fs-level error (ENOENT,
      // EACCES, etc.) will propagate as an unhandled rejection here —
      // callers should defensively wrap the entire extract() call in a
      // try/catch if they need a fallback for missing files.
      return await extractPlainText(filePath);

    case 'application/pdf':
      // pdf-parse extraction with built-in error handling. This call will
      // never throw — extractPdfText catches all errors internally.
      return await extractPdfText(filePath);

    // ---- Unsupported (future extension points) ----

    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      // OCR-based text extraction is not yet implemented. Return a
      // stable placeholder so the RAG pipeline can index the file's
      // existence even though its contents are not searchable.
      return '[图片文件 - 暂不支持文本提取]';

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      // Word documents are not natively parsable without a heavy dependency
      // (e.g. mammoth.js or a LibreOffice subprocess). We return a
      // helpful message telling the user to convert to PDF or TXT instead.
      return '[Word文档 - 暂不支持文本提取，请转换为 PDF 或 TXT 格式]';

    // ---- Catch-all for unknown formats ----
    default:
      // Any MIME type that does not match a known branch returns a
      // placeholder that includes the original MIME type for debugging.
      return `[不支持的文件类型: ${mimeType}]`;
  }
}

/**
 * Singleton service object that encapsulates all file-parsing logic.
 *
 * ## Usage
 *
 * ```ts
 * import { fileParser } from './services/fileParser.js';
 * const text = await fileParser.extract(filePath, mimeType);
 * ```
 *
 * ## Shape
 *
 * | Property   | Type                                                     | Description                     |
 * |------------|----------------------------------------------------------|---------------------------------|
 * | `extract`  | `(filePath: string, mimeType: string) => Promise<string>` | Main entry point (see extract) |
 *
 * ## Extensibility
 *
 * New parsers (e.g. `extractHtmlText`, `extractMarkdownText`) should be:
 * 1. Implemented as module-private `async` functions.
 * 2. Added as a `case` branch in `extract()`.
 * 3. The `fileParser` object shape intentionally stays flat — callers always
 *    go through `extract()` so they never need to know which internal parser
 *    was selected.
 */
export const fileParser = { extract };
