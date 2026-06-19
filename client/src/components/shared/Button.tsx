/**
 * Button — shared presentational component.
 *
 * Renders a styled `<button>` whose appearance is driven by `variant` and
 * `size` props. All standard button HTML attributes are forwarded via the
 * rest spread, making the component a drop-in replacement for a native button.
 *
 * @module Button
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.less';

/**
 * Props accepted by the Button component.
 *
 * Extends the native `<button>` attributes so consumers can pass `onClick`,
 * `type`, `aria-*` attributes, etc. without extra prop declarations.
 */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant. Defaults to `'primary'`. */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Size preset. Defaults to `'md'`. */
  size?: 'sm' | 'md' | 'lg';
  /** Button label / content (required). */
  children: ReactNode;
}

/**
 * A reusable button with variant and size presets.
 *
 * @param props - See {@link ButtonProps}.
 * @returns A styled `<button>` element.
 *
 * @example
 * ```tsx
 * <Button variant="secondary" size="lg" onClick={handleClick}>
 *   Save
 * </Button>
 * ```
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {/* Compose class names: base style + variant + size + consumer overrides */}
      className={`${styles.button} ${styles[variant]} ${styles[size]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
