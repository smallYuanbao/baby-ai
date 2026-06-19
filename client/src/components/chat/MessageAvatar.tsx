/**
 * @fileoverview MessageAvatar — Role-based avatar icon for chat messages.
 *
 * Renders a circular avatar for a single chat message. The visual treatment
 * depends on the message `role`:
 * - **assistant** — a custom SVG illustration (a friendly bear/panda face)
 *   on a pale orange (@primary-100) background.
 * - **user** — a generic person silhouette SVG (Heroicons "user" path) on a
 *   brand orange (@primary-500 / @white) background.
 *
 * The component is a pure presentational leaf: it receives only the role and
 * returns the matching icon. It is typically rendered inside a message row
 * component such as `ChatMessage`.
 *
 * @module MessageAvatar
 */

import styles from './MessageAvatar.module.less';

/**
 * Props accepted by the {@link MessageAvatar} component.
 *
 * @property role - The chat participant role determining which avatar to show.
 *                  Must be `'user'` or `'assistant'`.
 */
interface MessageAvatarProps {
  role: 'user' | 'assistant';
}

/**
 * Renders a circular avatar icon corresponding to the given chat role.
 *
 * - When `role` is `'assistant'`, an illustrated bear/panda face is drawn
 *   using SVG primitives (circles, an ellipse for the nose, and a quadratic
 *   Bézier path for the mouth).
 * - When `role` is `'user'`, a standard person silhouette is shown.
 *
 * @param props - Component props (see {@link MessageAvatarProps}).
 * @returns A `<div>` containing the role-appropriate SVG icon.
 */
export function MessageAvatar({ role }: MessageAvatarProps) {
  // --- Assistant: illustrated bear/panda face ---
  if (role === 'assistant') {
    return (
      <div className={`${styles.avatar} ${styles.assistantAvatar}`}>
        <svg viewBox="0 0 100 100" className={styles.assistantIcon}>
          {/* Left ear (outer) */}
          <circle cx="28" cy="32" r="12" fill="#fff7ed" />
          {/* Right ear (outer) */}
          <circle cx="72" cy="32" r="12" fill="#fff7ed" />
          {/* Head / face background */}
          <circle cx="50" cy="55" r="28" fill="#fff7ed" />
          {/* Left ear (inner / darker) */}
          <circle cx="28" cy="32" r="6" fill="#fdba74" />
          {/* Right ear (inner / darker) */}
          <circle cx="72" cy="32" r="6" fill="#fdba74" />
          {/* Left eye (dark) */}
          <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
          {/* Right eye (dark) */}
          <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
          {/* Left eye catchlight (white highlight) */}
          <circle cx="41" cy="51" r="1.5" fill="white" />
          {/* Right eye catchlight (white highlight) */}
          <circle cx="61" cy="51" r="1.5" fill="white" />
          {/* Nose / snout */}
          <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
          {/* Smile — quadratic Bézier curve from left to right, dipping downward */}
          <path d="M40 70 Q50 78 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  // --- User: generic person silhouette (Heroicons "user" path) ---
  return (
    <div className={`${styles.avatar} ${styles.userAvatar}`}>
      <svg className={styles.userIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {/* Head circle + shoulder arc combined in a single path */}
        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    </div>
  );
}
