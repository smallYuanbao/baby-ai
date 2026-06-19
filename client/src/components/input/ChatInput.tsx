/**
 * ChatInput — The primary chat compose bar rendered at the bottom of the chat screen.
 *
 * Responsibilities:
 * - Manages local text state (controlled textarea)
 * - Integrates file upload (via {@link useFileUpload}) and speech recognition
 *   (via {@link useSpeechRecognition})
 * - Auto-resizes the textarea up to a max height of 120px
 * - Dispatches the composed message (text + optional file) to the parent via
 *   the `onSend` callback
 * - Renders an inline file preview when a file is attached
 *
 * @module ChatInput
 */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { FileUploadButton } from './FileUploadButton';
import { FilePreview } from './FilePreview';
import { VoiceToggle } from '../shared/VoiceToggle';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import styles from './ChatInput.module.less';

/**
 * Props accepted by the {@link ChatInput} component.
 */
interface ChatInputProps {
  /**
   * Callback fired when the user submits a message.
   * @param message - The trimmed text content.
   * @param fileId   - Optional server-side ID of an uploaded file.
   * @param fileName - Optional original file name (for display purposes).
   */
  onSend: (message: string, fileId?: string, fileName?: string) => void;
  /**
   * When `true`, the entire input area (textarea, buttons) is disabled.
   * Useful while the assistant is generating a response or during loading states.
   */
  disabled?: boolean;
}

/**
 * Renders the chat input bar including:
 * - A file-attachment button (with inline file preview when a file is selected)
 * - A voice-input toggle (only rendered when the browser supports speech recognition)
 * - An auto-resizing textarea for typed input
 * - A send button (which also acts as a visual affordance for submission)
 *
 * Keyboard shortcut: `Enter` sends the message; `Shift + Enter` inserts a newline.
 */
export function ChatInput({ onSend, disabled }: ChatInputProps) {
  /** Raw text value of the input area. */
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { fileState, inputRef, selectFile, handleFileChange, clearFile } = useFileUpload();
  const { isSupported: voiceSupported, isListening, interimText, startListening, stopListening } = useSpeechRecognition();

  // Sync live speech-recognition transcript into the textarea while listening.
  useEffect(() => {
    if (interimText) {
      setText(interimText);
    }
  }, [interimText]);

  /** Toggles voice recognition on/off. */
  const handleVoiceToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  /**
   * Adjusts the textarea height to fit its content.
   * Resets to 'auto' first so `scrollHeight` reflects the real content height,
   * then clamps to a maximum of 120px to prevent the input from overtaking the screen.
   */
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  /**
   * Validates, dispatches the message, and resets local state.
   * No-ops when the text is blank or the input is disabled.
   */
  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return;
    onSend(text.trim(), fileState?.fileId, fileState?.file?.name);
    setText('');
    clearFile();
    // Collapse the textarea back to a single line after sending.
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, disabled, fileState, onSend, clearFile]);

  /**
   * Keyboard handler — `Enter` (without Shift) sends the message.
   * Holding `Shift` allows the default newline behaviour so the user can compose
   * multi-line messages.
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  /** Updates the controlled text state and re-measures the textarea height. */
  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustTextareaHeight();
    },
    [adjustTextareaHeight],
  );

  return (
    <div className={styles.wrapper}>
      {/* File preview — only visible when a file has been selected but not yet sent/cleared. */}
      {fileState && (
        <div className={styles.filePreview}>
          <FilePreview
            fileName={fileState.file.name}
            preview={fileState.preview}
            uploading={fileState.uploading}
            onRemove={clearFile}
          />
        </div>
      )}

      {/* Main input row: attachment button, voice toggle, textarea, send button. */}
      <div className={styles.inputArea}>
        {/* Hidden file input triggered by the file-attachment button. */}
        <div className={styles.attachButton}>
          <FileUploadButton
            inputRef={inputRef}
            onChange={handleFileChange}
            disabled={disabled}
          />
        </div>

        {/* Voice-input toggle — visible only when the browser supports the Web Speech API. */}
        <div className={styles.micButton}>
          <VoiceToggle
            isListening={isListening}
            isSupported={voiceSupported}
            onToggle={handleVoiceToggle}
            disabled={disabled}
          />
        </div>

        {/* Auto-resizing textarea for the user's typed message. */}
        <div className={styles.textareaWrapper}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder="输入你的育儿问题..."
            disabled={disabled}
            rows={1}
            className={styles.textarea}
            // 44px matches a single-line height; 120px is the max to avoid
            // the input growing taller than a comfortable chat viewport.
            style={{ minHeight: '44px', maxHeight: '120px' }}
          />
        </div>

        {/* Send button — disabled when the textarea is empty or the component is locked. */}
        <button
          onClick={handleSend}
          disabled={!text.trim() || disabled}
          className={styles.sendButton}
          title="发送消息"
          // aria-label would be redundant here because `title` already provides
          // an accessible name and the SVG is decorative.
        >
          <svg className={styles.sendIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>

      {/* Keyboard shortcut hint — informs the user that Enter sends and Shift+Enter inserts a newline. */}
      <p className={styles.hint}>
        按 Enter 发送，Shift + Enter 换行
      </p>
    </div>
  );
}
