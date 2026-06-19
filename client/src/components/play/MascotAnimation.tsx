/**
 * MascotAnimation — Animated SVG mascot character for the play area.
 *
 * Renders a cute fox-like mascot face whose expression changes based on the
 * current mood. Supports a bouncy "happy" state and a neutral "thinking" state.
 *
 * @module MascotAnimation
 */

import styles from './MascotAnimation.module.less';

/**
 * Props accepted by the {@link MascotAnimation} component.
 */
interface MascotAnimationProps {
  /** The mascot's current emotional state, which controls the mouth shape and animation. */
  mood: 'happy' | 'thinking';
}

/**
 * Renders an inline SVG mascot that reacts to the given mood.
 *
 * @param props          - Component props.
 * @param props.mood     - Currently active mood; `'happy'` triggers a bounce
 *                         animation and a smile, while `'thinking'` shows a
 *                         flat mouth.
 * @returns A `div` wrapping an SVG fox-like face.
 *
 * @example
 * ```tsx
 * <MascotAnimation mood="happy" />
 * ```
 */
export function MascotAnimation({ mood }: MascotAnimationProps) {
  return (
    <div className={`${styles.mascot} ${mood === 'happy' ? 'animate-bounce' : ''}`}>
      <svg viewBox="0 0 100 100" className={styles.svg}>
        {/* -- Head -- */}
        <circle cx="50" cy="55" r="28" fill="#fff7ed" stroke="#fed7aa" strokeWidth="1.5" />

        {/* -- Left ear (outer then inner) -- */}
        <circle cx="28" cy="32" r="12" fill="#fff7ed" stroke="#fed7aa" strokeWidth="1.5" />
        <circle cx="28" cy="32" r="6" fill="#fdba74" />

        {/* -- Right ear (outer then inner) -- */}
        <circle cx="72" cy="32" r="12" fill="#fff7ed" stroke="#fed7aa" strokeWidth="1.5" />
        <circle cx="72" cy="32" r="6" fill="#fdba74" />

        {/* -- Left eye (dark circle + white highlight) -- */}
        <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
        <circle cx="41" cy="51" r="1.5" fill="white" />

        {/* -- Right eye (dark circle + white highlight) -- */}
        <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
        <circle cx="61" cy="51" r="1.5" fill="white" />

        {/* -- Nose -- */}
        <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />

        {/* -- Mouth: curves up for "happy", flat for "thinking" -- */}
        {mood === 'happy' ? (
          <path d="M40 70 Q50 80 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        ) : (
          <path d="M40 73 Q50 70 60 73" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        )}
      </svg>
    </div>
  );
}
