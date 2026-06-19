/**
 * @fileoverview API type definitions for the baby-ai application.
 *
 * This module centralizes TypeScript interfaces that describe the shape of
 * API responses exchanged between the client and the backend. It serves as
 * the single source of truth for API contracts, ensuring that components,
 * services, and error-handling logic all agree on response structures.
 *
 * Types defined here are intentionally narrow — they only model the wire
 * format, not derived or enriched shapes built downstream.
 *
 * @module api
 */

/**
 * Standardised error envelope returned by the backend for any non-2xx response.
 *
 * @description
 * Every API error response is expected to conform to this shape so that
 * client-side error handlers can consistently parse `error` (user-facing
 * message) and `code` (machine-readable constant) regardless of the endpoint.
 *
 * @property {string} error  — Human-readable error message suitable for display.
 * @property {string} code   — Machine-readable error code (e.g. `FILE_TOO_LARGE`).
 * @property {unknown} [details] — Optional payload with additional context
 *   such as field-level validation errors or debug metadata.
 */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

/**
 * Successful response body returned after a file is uploaded.
 *
 * @description
 * After the client POSTs a file to the upload endpoint, the backend returns
 * this payload so the client can reference the file in subsequent requests
 * (e.g. attaching it to a message), show the original name to the user, and
 * optionally display the extracted text preview.
 *
 * @property {string} fileId       — Server-generated unique identifier for the stored file.
 * @property {string} originalName — The file name as supplied by the user at upload time.
 * @property {string} mimeType     — Detected MIME type (e.g. `image/png`, `application/pdf`).
 * @property {number} size         — File size in bytes.
 * @property {string} [extractedText] — Plain text extracted from the file when the backend
 *   supports content extraction (e.g. from PDFs or office documents). Absent for binary-only
 *   formats like images.
 */
export interface UploadResponse {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  extractedText?: string;
}
