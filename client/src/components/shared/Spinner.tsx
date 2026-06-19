/**
 * Spinner — a lightweight, accessible loading indicator.
 *
 * Renders a spinning SVG ring with Tailwind's {@code animate-spin}. Sizing
 * is driven by CSS Module classes ({@code sm | md | lg}) so the animation
 * stays consistent across contexts.
 *
 * @file client/src/components/shared/Spinner.tsx
 */

import styles from './Spinner.module.less';

/**
 * Props accepted by the {@link Spinner} component.
 */
interface SpinnerProps {
  /** Size variant — maps to a CSS Module class. @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS class names forwarded to the root element. */
  className?: string;
}

/**
 * Spinner component — renders an accessible, animated loading ring.
 *
 * @example
 * ```tsx
 * // Default medium spinner
 * <Spinner />
 *
 * // Small spinner with custom class
 * <Spinner size="sm" className="my-4" />
 * ```
 *
 * @param props - See {@link SpinnerProps}.
 * @returns A {@code <div>} containing the animated SVG ring.
 */
export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <div
      className={`${styles[size]} ${className} animate-spin`}
      role="status"
      aria-label="加载中"
    >
      {/*
       * Two-part SVG ring:
       * 1. A full background circle at 25 % opacity (the "track").
       * 2. A partial arc at 75 % opacity (the "head") that creates the
       *    spinning effect when the parent is rotated.
       */}
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Background track */}
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        {/* Spinning arc — the visible "head" of the loader */}
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.75"
        />
      </svg>
    </div>
  );
}
