/**
 * VoiceToggle — A microphone toggle button for voice/speech input.
 *
 * Renders a circular button that starts and stops browser-based speech
 * recognition. When the browser does not support the Web Speech API the
 * component renders nothing.
 *
 * @file client/src/components/shared/VoiceToggle.tsx
 */

import styles from './VoiceToggle.module.less';

/** Props accepted by the {@link VoiceToggle} component. */
interface VoiceToggleProps {
  /** Whether the speech recogniser is currently listening. */
  isListening: boolean;
  /** `true` when the browser supports the Web Speech API. */
  isSupported: boolean;
  /** Callback fired when the user clicks the toggle. */
  onToggle: () => void;
  /** If `true`, the button is disabled (e.g. while a request is in-flight). */
  disabled?: boolean;
}

/**
 * A microphone button that toggles voice input on and off.
 *
 * The button is **hidden** on unsupported browsers (`isSupported === false`).
 * When listening, a red pulsing background provides a visual cue; otherwise
 * the button appears as a subdued grey icon that highlights on hover.
 *
 * @param props - See {@link VoiceToggleProps}
 * @returns A `<button>` element, or `null` when unsupported.
 */
export function VoiceToggle({ isListening, isSupported, onToggle, disabled }: VoiceToggleProps) {
  // Gracefully hide the control when the browser lacks speech recognition.
  if (!isSupported) return null;

  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`
        ${styles.button}
        ${isListening ? `${styles.listening} animate-pulse` : styles.idle}
      `}
      title={isListening ? '正在聆听...' : '语音输入'}
      aria-label={isListening ? '停止语音输入' : '开始语音输入'}
    >
      {/* Microphone icon (Heroicons-style SVG) */}
      <svg className={styles.icon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {/* Mic body + stand */}
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
        {/* Sound-wave arcs */}
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M19 10v2a7 7 0 01-14 0v-2" />
        {/* Mic stand / legs */}
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19v4M8 23h8" />
      </svg>
    </button>
  );
}
