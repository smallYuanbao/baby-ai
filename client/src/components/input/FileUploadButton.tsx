/**
 * FileUploadButton
 *
 * Renders a file-upload trigger consisting of a visually hidden native
 * `<input type="file">` and a visible IconButton (paperclip icon).
 *
 * Clicking the IconButton programmatically clicks the hidden input, opening
 * the OS file-picker.  This pattern gives full styling control over the
 * trigger while keeping the native file-selection behaviour.
 *
 * State managed **outside** this component (the caller owns the ref and the
 * change handler); this component itself is stateless.
 */
import type { RefObject } from 'react';
import { IconButton } from '../shared/IconButton';
import styles from './FileUploadButton.module.less';

/** Props for {@link FileUploadButton}. */
interface FileUploadButtonProps {
  /** Ref attached to the hidden `<input type="file">` so the button can
   *  trigger it programmatically. */
  inputRef: RefObject<HTMLInputElement>;

  /** Called when the user selects one or more files via the native picker. */
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  /** When `true`, the trigger button is disabled and the user cannot open the
   *  file picker. */
  disabled?: boolean;
}

/**
 * Renders a file-upload button for the chat input area.
 *
 * The hidden `<input>` accepts common document and image formats
 * (`.txt`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.doc`, `.docx`).
 * The visible trigger is an {@link IconButton} with a paperclip SVG icon,
 * rendered in “ghost” variant for a subtle appearance.
 *
 * Accessibility: the IconButton carries a Chinese label (“上传文件” – “upload
 * file”) that serves as its accessible name.
 */
export function FileUploadButton({ inputRef, onChange, disabled }: FileUploadButtonProps) {
  return (
    <>
      {/* Hidden native file input – styled off-screen via CSS module */}
      <input
        ref={inputRef}
        type="file"
        onChange={onChange}
        className={styles.input}
        accept=".txt,.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx"
      />
      {/* Visible trigger: clicking programmatically opens the hidden input */}
      <IconButton
        label="上传文件"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        variant="ghost"
      >
        {/* Paperclip icon (Heroicons outline style) */}
        <svg className={styles.icon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
      </IconButton>
    </>
  );
}
