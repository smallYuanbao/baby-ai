/**
 * @file TypingIndicator — a chat-bubble indicator shown while the AI companion is generating a response.
 *
 * Renders a small bear avatar alongside a "thinking" label and three animated bouncing dots,
 * reinforcing the brand personality and giving the user a clear loading state.
 *
 * @module chat/TypingIndicator
 */

import styles from './TypingIndicator.module.less';

/**
 * Renders an inline loading state that mimics an incoming message bubble.
 *
 * The component combines:
 * - A bear‑face SVG avatar (brand mascot) for visual identity.
 * - Three sequentially‑delayed bouncing dots to convey that processing is ongoing.
 *
 * @returns A JSX fragment representing the typing indicator row.
 */
export function TypingIndicator() {
  return (
    <div className={`${styles.wrapper} animate-fade-in`}>
      {/* Mascot avatar: a simple bear face built from SVG primitives */}
      <div className={styles.avatar}>
        <svg viewBox="0 0 100 100" className={styles.avatarIcon}>
          {/* Head (main face circle) */}
          <circle cx="50" cy="55" r="28" fill="#fff7ed" />
          {/* Left ear */}
          <circle cx="28" cy="32" r="12" fill="#fff7ed" />
          {/* Right ear */}
          <circle cx="72" cy="32" r="12" fill="#fff7ed" />
          {/* Nose — a narrow ellipse centred below the eyes */}
          <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
        </svg>
      </div>

      {/* Animated "thinking" bubble with three bouncing dots */}
      <div className={styles.bubble}>
        <span className={styles.thinkingText}>思考中</span>
        {/*
         * Each dot gets the same CSS animation class but a staggered animationDelay
         * (0s, 0.16s, 0.32s) so they bounce in sequence — creating a wave effect.
         */}
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`${styles.dot} animate-bounce-dot`}
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
    </div>
  );
}
