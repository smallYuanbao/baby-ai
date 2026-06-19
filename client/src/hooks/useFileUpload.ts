/**
 * @fileoverview useFileUpload Hook
 *
 * Manages the full lifecycle of a single file upload within the baby-ai client.
 * Coordinates between the UI layer (file input via a hidden `<input>` ref),
 * local preview generation (object URLs for images), and the API layer
 * (multipart upload via `api.uploadFile`).
 *
 * ## Data Flow
 *
 * ```
 * User gesture
 *   → selectFile() clicks hidden <input>
 *     → browser file picker opens
 *       → handleFileChange fires on file selection
 *         → preview URL generated (images only)
 *         → optimistic uploading state set
 *         → api.uploadFile(file) dispatched
 *           → SUCCESS: fileId stored, uploading cleared
 *           → FAILURE: state reset to null, error re-thrown
 *   → Consumer reads fileState to render preview + status
 *   → clearFile() revokes object URL, resets input, nulls state
 * ```
 *
 * Only one file is tracked at a time; selecting a new file replaces the
 * previous one. The old preview URL is revoked as part of `clearFile` (called
 * by the consumer before starting a new upload, or automatically on error).
 */

import { useState, useRef, useCallback } from 'react';
import { api } from '../services/api';
import type { UploadResponse } from '../types/api';

/**
 * Internal shape of the upload state tracked by this hook.
 *
 * Exposed to consumers via the {@link useFileUpload} return value so they can
 * render previews, spinners, and the uploaded file identifier.
 */
interface FileState {
  /** The raw `File` object selected by the user via the file picker. */
  file: File;
  /**
   * Object URL for local preview. Set only for image files; `null` for all
   * other file types. **Must** be revoked via {@link URL.revokeObjectURL} on
   * cleanup to prevent memory leaks.
   */
  preview: string | null;
  /** Whether an upload request is currently in flight. */
  uploading: boolean;
  /**
   * Server-assigned file identifier, populated after a successful upload.
   * `undefined` until the upload completes.
   */
  fileId?: string;
}

/**
 * React hook that encapsulates single-file selection, preview generation,
 * multipart upload, and cleanup.
 *
 * Designed to be used with a hidden `<input type="file">` rendered in the
 * consuming component. The hook owns the ref to that input so it can
 * imperatively trigger the native file picker via {@link selectFile}.
 *
 * ## Lifecycle
 *
 * 1. **Idle** — `fileState` is `null`.
 * 2. **Selecting** — `selectFile()` clicks the hidden input; the browser file
 *    picker opens.
 * 3. **Uploading** — `handleFileChange` fires, preview is generated (images
 *    only), `fileState.uploading` is `true`.
 * 4. **Complete** — `fileState.uploading` is `false`, `fileState.fileId` holds
 *    the server-assigned ID.
 * 5. **Cleared** — `clearFile()` revokes the object URL, resets the input
 *    value, and sets `fileState` back to `null`.
 *
 * ## Error Handling
 *
 * If the upload fails the hook resets its own state to `null` and **re-throws**
 * the error so the calling component can surface it (e.g. via a toast or
 * inline error message).
 *
 * @returns An object with the following properties:
 *
 *   - `fileState` (`FileState | null`) — Current upload state (raw file,
 *     preview URL, uploading flag, server fileId). `null` when no file is
 *     active.
 *
 *   - `inputRef` (`React.RefObject<HTMLInputElement>`) — Ref to attach to a
 *     hidden `<input type="file">` element. The hook imperatively clicks this
 *     ref to open the file picker.
 *
 *   - `selectFile` (`() => void`) — Callback with stable identity. Triggers
 *     the native file picker dialog.
 *
 *   - `handleFileChange` (`(e: React.ChangeEvent<HTMLInputElement>) =>
 *     Promise<void>`) — Async event handler for the hidden input's `onChange`.
 *     Extracts the first selected file, generates a preview, and uploads via
 *     the API. Re-throws on failure.
 *
 *   - `clearFile` (`() => void`) — Resets all state, revokes any object URL,
 *     and clears the input's `.value` so the same file can be re-selected.
 */
export function useFileUpload() {
  /**
   * Core state: `null` when no file is active, otherwise holds the current
   * file's metadata and upload progress.
   */
  const [fileState, setFileState] = useState<FileState | null>(null);

  /**
   * Ref pointing to a hidden `<input type="file">` rendered by the consumer.
   * Used to programmatically trigger the native file picker without showing a
   * visible input element.
   */
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Imperatively clicks the hidden file input to open the browser's native
   * file picker dialog.
   *
   * Stable identity (empty deps array) — safe to pass as a prop without
   * causing re-renders.
   */
  const selectFile = useCallback(() => {
    inputRef.current?.click();
  }, []);

  /**
   * Async event handler for the hidden file input's `onChange`.
   *
   * ## Processing Steps
   *
   * 1. **Extract** — reads the first file from `e.target.files`.
   * 2. **Guard** — bails out early if the user cancelled the file picker
   *    (no file selected).
   * 3. **Preview** — generates an object URL for image files so consumers can
   *    render a thumbnail before the upload completes. Non-image files get
   *    `null`.
   * 4. **Optimistic state** — sets `fileState` with `uploading: true` so the
   *    UI can show a spinner immediately.
   * 5. **Upload** — calls `api.uploadFile` (multipart form upload).
   * 6. **Success** — merges the server-assigned `fileId` into state and clears
   *    the `uploading` flag. Uses the updater form of `setFileState` to guard
   *    against stale closures if a rapid re-upload occurs.
   * 7. **Failure** — resets `fileState` to `null` and **re-throws** the error
   *    so the calling component can surface it.
   *
   * ## Edge Cases
   *
   * - **Cancelled picker**: `e.target.files` is empty → no-op.
   * - **Non-image files**: `preview` is set to `null`; no object URL is
   *   created, so no revocation is needed on cleanup.
   * - **Rapid re-selection**: The updater form of `setFileState` in the
   *   success handler prevents overwriting a newer file selection with stale
   *   state from an in-flight upload.
   *
   * @param e - The synthetic `ChangeEvent` from the hidden
   *   `<input type="file">`.
   */
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Extract the first selected file (the input is configured for single-file)
    const file = e.target.files?.[0];
    // Guard: user cancelled the picker or the FileList was empty
    if (!file) return;

    // Generate a local object-URL preview for images so the consumer can
    // show a thumbnail before the upload completes. Non-image files skip
    // this — no URL is created, so no revocation is needed later.
    let preview: string | null = null;
    if (file.type.startsWith('image/')) {
      preview = URL.createObjectURL(file);
    }

    // Optimistic update: immediately show the file + spinner
    setFileState({ file, preview, uploading: true });

    try {
      const result = await api.uploadFile<UploadResponse>(file);
      // Merge server-assigned fileId into state and clear the uploading flag.
      // Using the updater form of setState guards against stale closures in
      // the event of a rapid file re-selection while an upload is in flight.
      setFileState((prev) => prev ? {
        ...prev,
        uploading: false,
        fileId: result.fileId,
      } : null);
    } catch (err) {
      // On failure, discard all local state so the consumer doesn't render a
      // broken/missing file. Re-throw so the caller can show an error toast.
      setFileState(null);
      throw err;
    }
  }, []);

  /**
   * Resets the hook to its initial (idle) state, cleaning up all side effects.
   *
   * ## Cleanup Steps
   *
   * 1. **Revoke object URL** — calls {@link URL.revokeObjectURL} on the
   *    preview URL (if one exists) to free browser memory. This is critical
   *    for large images — object URLs are not garbage-collected automatically
   *    and will leak until the document is unloaded.
   * 2. **Reset state** — sets `fileState` to `null`.
   * 3. **Clear input** — resets the hidden input's `.value` to `''`. Without
   *    this, browsers will not fire `onChange` when the user re-selects the
   *    same file path, because the input's value did not change from the
   *    browser's perspective.
   *
   * ## Usage
   *
   * Call this when the user wants to remove the current file, after a
   * successful upload (to prepare for the next file), or on component
   * unmount (from a `useEffect` cleanup).
   *
   * ## Dependency Note
   *
   * `fileState` is in the deps array so the callback always sees the current
   * preview URL to revoke. This means `clearFile` gets a new identity whenever
   * `fileState` changes — pass it as a handler, not as a dependency to other
   * hooks.
   */
  const clearFile = useCallback(() => {
    // Revoke the blob URL to prevent memory leaks.
    // Object URLs persist for the lifetime of the document unless explicitly
    // revoked — even after the blob is no longer referenced.
    if (fileState?.preview) {
      URL.revokeObjectURL(fileState.preview);
    }
    // Discard all file state
    setFileState(null);
    // Reset the input's value so the same file path can trigger onChange again.
    // Browsers skip the change event when the new value equals the old value.
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [fileState]);

  return {
    fileState,
    inputRef,
    selectFile,
    handleFileChange,
    clearFile,
  };
}
