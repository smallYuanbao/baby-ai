/**
 * @file ErrorBanner – a shared inline error banner component.
 *
 * Displays a coloured error strip with an icon, a message, and optional
 * action buttons ("retry" and "dismiss"). Used throughout the app to surface
 * recoverable errors (network failures, server rejects, etc.) without
 * blocking the entire UI.
 */

import styles from './ErrorBanner.module.less';

/** Props accepted by the {@link ErrorBanner} component. */
interface ErrorBannerProps {
  /** Human-readable error description shown in the banner body. */
  message: string;
  /** If provided, a dismiss ("✕") button is rendered. */
  onDismiss?: () => void;
  /** If provided, a "重试" (retry) button is rendered. */
  onRetry?: () => void;
}

/**
 * Render an inline error banner with optional action buttons.
 *
 * The banner is a flex row containing:
 * 1. A warning icon (⚠️)
 * 2. The error message text (flex-grows to fill available space)
 * 3. An actions area that conditionally shows a retry button and/or a
 *    dismiss button.
 *
 * @param message – Error text to display.
 * @param onDismiss – Callback fired when the user clicks the dismiss button.
 * @param onRetry – Callback fired when the user clicks the retry button.
 */
export function ErrorBanner({ message, onDismiss, onRetry }: ErrorBannerProps) {
  return (
    <div className={`animate-fade-in ${styles.banner}`}>
      {/* Leading warning icon */}
      <span className={styles.icon}>⚠️</span>

      {/* Error message body — expands to fill remaining horizontal space */}
      <p className={styles.message}>{message}</p>

      {/* Optional action buttons */}
      <div className={styles.actions}>
        {onRetry && (
          <button
            onClick={onRetry}
            className={styles.retryButton}
          >
            重试
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className={styles.dismissButton}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
