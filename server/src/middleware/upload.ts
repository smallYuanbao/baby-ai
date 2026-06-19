import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';

/**
 * Multer Upload Middleware
 * ========================
 *
 * This middleware configures **multer** for handling `multipart/form-data` file
 * uploads. It is attached to any Express route that accepts file uploads (e.g.
 * chat attachment endpoints, document ingestion pipelines).
 *
 * Responsibilities:
 * 1. **Disk storage** — saves uploaded files to a configured directory on the
 *    server filesystem with a UUID-based filename to prevent collisions and
 *    path-traversal attacks.
 * 2. **Size limiting** — rejects files larger than the configured maximum
 *    (derived from `config.upload.maxFileSizeMB`, converted to bytes).
 * 3. **MIME-type allowlisting** — only permits a known set of safe MIME types
 *    (text, PDF, common image formats, Word documents). Anything else is
 *    rejected with a Chinese-language error message.
 *
 * ### Where this middleware is used
 *
 * Typically mounted on routes like:
 *
 *     router.post('/upload', upload.single('file'), handler);
 *     router.post('/attachments', upload.array('files', 5), handler);
 *
 * ### Error handling
 *
 * Multer errors (e.g. `LIMIT_FILE_SIZE`, invalid MIME type) are surfaced as
 * native `Error` objects. Downstream Express error-handling middleware should
 * inspect `err.code` (for multer-specific codes) or `err.message` and return
 * appropriate HTTP 4xx status codes. The file-type rejection message is in
 * Chinese (`不支持的文件类型`), so client-facing UIs should be prepared to
 * receive and display it.
 *
 * ### Edge cases
 *
 * - **No file attached**: multer treats a missing file field as a successful
 *   (empty) upload — the route handler must check whether `req.file` is
 *   `undefined`.
 * - **MIME spoofing**: this middleware trusts the `Content-Type` header sent by
 *   the client. It does **not** perform magic-byte inspection or deep content
 *   validation. If content-sniffing is required, add that in a downstream
 *   middleware or service layer.
 * - **Disk exhaustion**: multer does not enforce a total-upload quota. Repeated
 *   large uploads could fill the disk. Consider an OS-level quota or a
 *   scheduled cleanup job for the upload directory.
 * - **Filename collisions**: UUIDs make collisions statistically impossible,
 *   but the original extension is preserved verbatim — a malicious client could
 *   supply a filename with double extensions (e.g. `evil.pdf.exe`). Storage and
 *   serving layers should not rely on the extension for security decisions.
 * - **Concurrent writes**: multer handles concurrent uploads safely by writing
 *   each file with a unique UUID name.
 */

// ---------------------------------------------------------------------------
// Disk storage engine
// ---------------------------------------------------------------------------

/**
 * Configured multer disk-storage engine.
 *
 * - `destination`: resolved from `config.upload.dir`. The directory must exist
 *    and be writable by the Node process at startup; multer will **not** create
 *    it automatically and will throw if the path is missing or inaccessible.
 * - `filename`: generates a collision-resistant name by combining a random
 *    UUID (v4) with the original file extension extracted via `path.extname()`.
 *    The original client-supplied filename is discarded to prevent path-traversal
 *    and naming conflicts.
 */
const storage = multer.diskStorage({
  destination: config.upload.dir,

  /**
   * @param _req  - Express request object (unused; the original filename is
   *                only read from the `file` parameter).
   * @param file  - Multer file descriptor; `file.originalname` provides the
   *                client-supplied filename from which the extension is extracted.
   * @param cb    - Callback invoked with `(error, filename)`. On success the
   *                error argument is `null`.
   */
  filename: (_req, file, cb) => {
    // Extract the extension from the original filename (includes the leading dot, e.g. ".pdf").
    const ext = path.extname(file.originalname);
    // Generate a random UUID v4 to guarantee a unique filename on disk.
    const id = uuidv4();
    // Build the final on-disk name: <uuid><original_extension>
    cb(null, `${id}${ext}`);
  },
});

// ---------------------------------------------------------------------------
// Exported middleware
// ---------------------------------------------------------------------------

/**
 * Pre-configured multer instance ready to be mounted as Express middleware.
 *
 * Usage examples:
 *
 *     // Single file (field name "file")
 *     app.post('/upload', upload.single('file'), handler);
 *
 *     // Multiple files (field name "files", max 5)
 *     app.post('/upload', upload.array('files', 5), handler);
 *
 *     // Mixed fields
 *     app.post('/upload', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'docs', maxCount: 3 }]), handler);
 *
 * ### Limits
 *
 * - `fileSize`: the product of `config.upload.maxFileSizeMB` × 1024 × 1024.
 *   When exceeded, multer rejects the request with a `LIMIT_FILE_SIZE` error.
 *
 * ### File filter
 *
 * - **Allowed MIME types**: `text/plain`, `application/pdf`, `image/png`,
 *   `image/jpeg`, `image/gif`, `image/webp`,
 *   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 *   (DOCX), `application/msword` (DOC).
 * - Any MIME type not in this list is rejected with an error whose message is
 *   the Chinese string `不支持的文件类型: <actual_mimetype>`.
 *
 * @param storage     - The `multer.diskStorage` instance defined above.
 * @param limits      - An object specifying upload constraints:
 *   @property {number} fileSize - Maximum file size in bytes.
 * @param fileFilter  - A function that receives the request, the file descriptor,
 *                      and a callback. Calls `cb(null, true)` to accept or
 *                      `cb(Error)` to reject.
 *
 * @returns {multer.Multer} A configured multer instance with `.single()`,
 * `.array()`, `.fields()`, and `.none()` methods for mounting on routes.
 */
export const upload = multer({
  storage,

  limits: {
    // Convert the configured megabyte limit into bytes for multer's fileSize limit.
    fileSize: config.upload.maxFileSizeMB * 1024 * 1024,
  },

  /**
   * MIME-type allowlist filter.
   *
   * @param _req  - Express request object (unused; only the file's declared
   *                MIME type is inspected).
   * @param file  - Multer file descriptor; `file.mimetype` carries the
   *                client-declared MIME type.
   * @param cb    - Callback: `cb(null, true)` to accept the file,
   *                `cb(new Error(...))` to reject it.
   */
  fileFilter: (_req, file, cb) => {
    // Whitelist of permitted MIME types. Only these types are allowed through.
    const allowed = [
      'text/plain',
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];

    if (allowed.includes(file.mimetype)) {
      // MIME type is in the allowlist — accept the file.
      cb(null, true);
    } else {
      // MIME type is not permitted — reject with a descriptive error.
      // The error message is in Chinese; downstream error handlers should relay
      // it to the client as part of a 400 (Bad Request) response.
      cb(new Error(`不支持的文件类型: ${file.mimetype}`));
    }
  },
});
