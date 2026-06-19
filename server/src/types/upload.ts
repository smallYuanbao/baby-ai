/**
 * Upload Type Definitions
 *
 * This module defines the core type contracts for file uploads within the
 * application. It sits at the boundary between the HTTP/REST layer and the
 * business-logic / persistence layer, serving as the canonical shape for
 * uploaded file metadata that flows through the system.
 *
 * Role in the architecture:
 * - **Ingestion boundary**: When a client uploads a file via the API, the
 *   incoming multipart data is normalized into an `UploadedFile` record
 *   before being handed off to downstream services (storage adapters, text
 *   extraction pipelines, vector indexing, etc.).
 * - **Pipeline contract**: `UploadedFile` is the input/output contract
 *   between steps in the document ingestion RAG pipeline. The `extractedText`
 *   field carries the output of the text-extraction step forward to the
 *   chunking and embedding steps.
 * - **Persistence schema**: Fields on this interface map directly to columns
 *   in the file-metadata store and to keys in object storage, ensuring a
 *   consistent representation from upload through retrieval.
 *
 * Separation of concerns:
 * - This file declares ONLY the type shape. It has no runtime logic,
 *   validation rules, or serialization helpers — those belong in dedicated
 *   service / utility modules.
 * - Consumers import this interface and rely on TypeScript structural
 *   compatibility; no class instantiation or DI registration is required.
 */

/**
 * Represents a file that has been received, validated, and persisted by the
 * upload subsystem.
 *
 * An `UploadedFile` record is created after the raw bytes have been written
 * to durable storage and the metadata has been recorded. It is the
 * authoritative reference that the rest of the system uses to locate and
 * process the file.
 *
 * Lifecycle:
 * 1. **Created** — after multipart parsing and storage write succeed.
 * 2. **Enriched** — the `extractedText` field is populated by the text
 *    extraction step (e.g. OCR, PDF parsing). Until that step runs the field
 *    is `undefined`.
 * 3. **Consumed** — downstream steps (chunking, embedding, indexing) read
 *    this record to locate the file and its extracted text.
 *
 * @example
 * ```ts
 * const file: UploadedFile = {
 *   fileId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
 *   originalName: "quarterly-report.pdf",
 *   mimeType: "application/pdf",
 *   size: 2_400_000,
 *   path: "uploads/2026/06/19/a1b2c3d4.pdf",
 *   extractedText: "Q1 Revenue was ...",
 * };
 * ```
 */
export interface UploadedFile {
  /**
   * Unique identifier for the uploaded file.
   *
   * This is the primary key used to reference the file across all subsystems
   * (storage, database, cache, queue messages). It is generated server-side
   * during the upload handshake, before the file bytes are received, so that
   * the client can use it for idempotency and progress tracking.
   *
   * Format: UUID v4 (RFC 9562).
   */
  fileId: string;

  /**
   * The original filename as provided by the client.
   *
   * This is NOT used as the storage key (see {@link path}) because filenames
   * can collide and may contain characters that are unsafe for the target
   * filesystem. It is retained for display purposes and for inferring the
   * file type when the MIME type is ambiguous.
   *
   * Security note: This value originates from the client and should be
   * treated as untrusted. It is sanitized before being stored (path-traversal
   * characters are stripped, length is capped), but consumers that render it
   * in HTML must still entity-encode it to prevent XSS.
   */
  originalName: string;

  /**
   * The MIME type of the file as declared by the client during upload.
   *
   * This value is taken from the `Content-Type` header of the multipart part.
   * It is **not** validated via magic-byte inspection at this layer —
   * server-side MIME sniffing is the responsibility of the validation service.
   *
   * Common values: `"application/pdf"`, `"text/plain"`, `"image/png"`,
   * `"application/vnd.openxmlformats-officedocument.wordprocessingml.document"`.
   */
  mimeType: string;

  /**
   * File size in bytes.
   *
   * This is the actual number of bytes written to storage, measured after the
   * upload stream completes. It is used for:
   * - Enforcing per-file and per-user quota limits.
   * - Displaying file size in the UI.
   * - Estimating token counts and processing costs before the extraction step.
   *
   * Guaranteed to be non-negative. A value of `0` indicates an empty file,
   * which may be rejected by downstream validation depending on configuration.
   */
  size: number;

  /**
   * The storage path (key) where the file bytes are persisted.
   *
   * This is the canonical location used by the storage adapter to read the
   * file back for processing or download. The path is generated server-side
   * and follows a deterministic scheme that includes the upload date and the
   * {@link fileId} (e.g. `"uploads/2026/06/19/a1b2c3d4.pdf"`).
   *
   * The scheme ensures:
   * - No collisions, even with identical original filenames.
   * - Date-based partitioning for efficient listing and lifecycle policies.
   * - Extension preservation for MIME-type hinting by object storage/CDNs.
   *
   * Consumers should treat this as an opaque key — do not parse or
   * reconstruct it.
   */
  path: string;

  /**
   * The full text content extracted from the file, if extraction has been
   * performed.
   *
   * This field is `undefined` after the initial upload and is populated
   * asynchronously by the text-extraction pipeline step. The extraction step
   * handles different file types:
   * - **PDF**: Text layer extraction (or OCR if the PDF is image-only).
   * - **Office documents**: XML parsing and text-node collection.
   * - **Images**: OCR via a vision model or Tesseract.
   * - **Plain text**: Pass-through with encoding normalization.
   *
   * Once populated, this field serves as the input to the chunking step in
   * the RAG pipeline. Downstream consumers MUST handle the `undefined` case
   * gracefully (the file may still be queued for extraction, or extraction
   * may have failed).
   *
   * Memory note: For very large files this string can be multiple megabytes.
   * Avoid loading all `extractedText` values for a batch of files into memory
   * simultaneously — stream or paginate instead.
   */
  extractedText?: string;
}
