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
   * 后端在上传时给出的文件归类。三态：`true` 与育儿相关 / `false` 无关 /
   * `null`/缺省 = 没判出来（按"不提示"处理，不要当成无关）。
   */
  parentingRelated?: boolean | null;
  /** 一句话文件摘要（后端归类时顺便给的，目前只用于提示文案的 title）。 */
  summary?: string | null;
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
export interface UseFileUploadOptions {
  /**
   * 单文件大小上限（MB）。来自 `GET /api/upload/formats`，与后端共用同一个值。
   * 未拿到时（接口还没返回）跳过预校验，由后端兜底。
   */
  maxFileSizeMB?: number;
}

export function useFileUpload(options: UseFileUploadOptions = {}) {
  const { maxFileSizeMB } = options;
  /**
   * Core state: `null` when no file is active, otherwise holds the current
   * file's metadata and upload progress.
   */
  const [fileState, setFileState] = useState<FileState | null>(null);

  /**
   * 最近一次上传失败的原因。**必须由 UI 显示出来** —— 这条状态存在的全部理由就是
   * 消灭"选了文件、它闪一下消失了、什么提示都没有"那种体验。
   */
  const [uploadError, setUploadError] = useState<string | null>(null);

  /**
   * Ref pointing to a hidden `<input type="file">` rendered by the consumer.
   * Used to programmatically trigger the native file picker without showing a
   * visible input element.
   */
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * 当前"有效"的那次上传对应的 File。
   *
   * 用来判断一个迟到的响应还算不算数：上传中点 ✕ 清掉、或者直接换选另一个文件后，
   * 旧请求回来时 `prev` 可能已经是**别的文件**的状态了。原实现只判断 `prev` 非空，
   * 于是旧文件的 fileId / 归类结果会被写进新文件里 —— 表面看是"上传成功了"，
   * 实际后端拿到的是另一份文件。
   */
  const activeFileRef = useRef<File | null>(null);

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
   * - **Rapid re-selection**: `activeFileRef` records which file the in-flight
   *   request belongs to; a response for a superseded file is discarded, so it
   *   cannot overwrite the newer selection's state.
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

    // 新选一次文件，旧错误就不再相关
    setUploadError(null);

    // 大小预校验：能本地判出来的错，没必要发一次请求再等后端拒。
    // 上限来自后端（/api/upload/formats），两边用的是同一个数。
    if (maxFileSizeMB && file.size > maxFileSizeMB * 1024 * 1024) {
      if (preview) URL.revokeObjectURL(preview);
      setUploadError(
        `文件太大：${(file.size / 1024 / 1024).toFixed(1)} MB，上限 ${maxFileSizeMB} MB`,
      );
      return;
    }

    // Optimistic update: immediately show the file + spinner
    setFileState({ file, preview, uploading: true });
    activeFileRef.current = file;

    try {
      const result = await api.uploadFile<UploadResponse>(file);
      // 这次响应已经过期（中途清掉或换选了别的文件）→ 丢弃，别污染当前状态。
      if (activeFileRef.current !== file) return;
      setFileState((prev) => prev ? {
        ...prev,
        uploading: false,
        fileId: result.fileId,
        // 归类结果跟着 fileState 走，供 FilePreview 在上传完成的一刻就给出提示
        parentingRelated: result.parentingRelated ?? null,
        summary: result.summary ?? null,
      } : null);
    } catch (err) {
      // 同理：旧文件的失败不该把新文件的状态也清掉、更不该弹出牛头不对马嘴的报错。
      if (activeFileRef.current !== file) return;
      // 失败时清掉本地状态，但把**原因**留下来给 UI 显示。
      //
      // 这里**不再 re-throw**：这个 handler 直接挂在 <input onChange> 上，而 React
      // 不会 await 一个 async handler —— 抛出去只会变成一条无人处理的 promise
      // rejection，界面上表现为"文件闪一下就没了，什么都不说"。
      // 原注释写的"Re-throw so the caller can show an error toast"里那个 caller
      // 从来没有存在过，toast 也从来没实现。
      setFileState(null);
      setUploadError(err instanceof Error ? err.message : '文件上传失败');
    }
    // maxFileSizeMB 必须进依赖：它是异步拉回来的，初值是 undefined。
    // 写死 [] 的话回调永远闭包住那个 undefined，大小预校验等于没写。
  }, [maxFileSizeMB]);

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
    // Discard all file state，并让在飞的上传响应过期
    activeFileRef.current = null;
    setFileState(null);
    // Reset the input's value so the same file path can trigger onChange again.
    // Browsers skip the change event when the new value equals the old value.
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [fileState]);

  return {
    fileState,
    uploadError,
    clearUploadError: () => setUploadError(null),
    inputRef,
    selectFile,
    handleFileChange,
    clearFile,
  };
}
