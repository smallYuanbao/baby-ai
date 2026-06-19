/**
 * FilePreview – Renders a preview card for a file selected or attached in an input area.
 *
 * Role in the UI: Displays a thumbnail (or a generic document placeholder icon),
 * the file name, an upload/ready status indicator, and a remove button. Used within
 * chat-input or form-attachment flows to give the user visual feedback about a file
 * they have selected before sending.
 *
 * State managed: This component is stateless (presentational). All state — preview
 * URL, upload progress, and the removal callback — is owned by the parent.
 */
import styles from './FilePreview.module.less';

/** Props for {@link FilePreview}. */
interface FilePreviewProps {
  /** Display name of the file (e.g. "report.pdf"). */
  fileName: string;
  /** Object URL or data URI for the thumbnail preview, or `null` when no preview is available (e.g. non-image files). */
  preview: string | null;
  /** Whether the file is currently being uploaded to the server. */
  uploading: boolean;
  /** Callback invoked when the user clicks the remove (✕) button. */
  onRemove: () => void;
}

/**
 * Renders a compact file-preview card with a thumbnail, file name, status, and remove control.
 *
 * When no image preview is available (e.g. non-image files), a generic document SVG icon is
 * shown in place of the thumbnail. The status line reflects whether the file is still uploading
 * or is ready to send.
 */
export function FilePreview({ fileName, preview, uploading, onRemove }: FilePreviewProps) {
  return (
    // animate-fade-in is a global utility class for the entry transition; wrapper uses CSS modules for scoped styles
    <div className={`animate-fade-in ${styles.wrapper}`}>
      {/* Thumbnail: render the image preview when available; otherwise show a generic document icon as a placeholder */}
      {preview ? (
        <img
          src={preview}
          alt={fileName}
          className={styles.thumbnail}
        />
      ) : (
        // Non-image files (or files without a generated preview) fall back to a document SVG icon
        <div className={styles.placeholder}>
          <svg className={styles.placeholderIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
      )}

      {/* File name and upload-status indicator */}
      <div className={styles.fileInfo}>
        <p className={styles.fileName}>{fileName}</p>
        {/* Conditional status: show "uploading" text while the file is being transferred, "ready" once complete */}
        {uploading ? (
          <p className={`${styles.fileStatus} ${styles.uploading}`}>上传中...</p>
        ) : (
          <p className={`${styles.fileStatus} ${styles.ready}`}>已就绪</p>
        )}
      </div>

      {/* Remove button: calls the parent-provided onRemove callback to detach the file.
           NOTE: this button lacks an aria-label — consider adding one for screen-reader users since the ✕ character alone may not be descriptive enough. */}
      {/* onRemove fires synchronously; the parent is responsible for any async cleanup (e.g. revoking object URLs) */}
      <button
        onClick={onRemove}
        className={styles.removeButton}
      >
        ✕
      </button>
    </div>
  );
}
