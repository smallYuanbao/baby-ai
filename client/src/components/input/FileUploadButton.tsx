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

  /**
   * `<input accept>` 的值，例如 `".pdf,.txt"`。
   *
   * **由调用方从后端 `/api/upload/formats` 拉取后传入**，不要在这里写死 ——
   * 前后端各维护一份支持列表必然脱节（曾经这里列了 9 种、后端只收 2 种，
   * 用户选个 Word 必然撞墙，而且撞得毫无提示）。
   *
   * 缺省时只列后端目前确实支持的两种，宁可少列也不要列出会被拒的格式。
   */
  accept?: string;
}

/**
 * Renders a file-upload button for the chat input area.
 *
 * The hidden `<input>` 的 accept 列表由调用方传入（来自后端 `/api/upload/formats`），
 * 这里不写死 —— 见 `accept` prop 的说明。
 * The visible trigger is an {@link IconButton} with a paperclip SVG icon,
 * rendered in “ghost” variant for a subtle appearance.
 *
 * Accessibility: the IconButton carries a Chinese label (“上传文件” – “upload
 * file”) that serves as its accessible name.
 */
export function FileUploadButton({ inputRef, onChange, disabled, accept = '.pdf,.txt' }: FileUploadButtonProps) {
  return (
    <>
      {/* Hidden native file input – styled off-screen via CSS module */}
      <input
        ref={inputRef}
        type="file"
        onChange={onChange}
        className={styles.input}
        accept={accept}
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
