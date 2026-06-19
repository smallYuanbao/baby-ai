/**
 * @fileoverview IconButton — a shared, accessible icon-only button component.
 *
 * Renders a `<button>` whose visible content is expected to be a single icon
 * (passed as `children`). The button text label is supplied via the `label`
 * prop and surfaced through `aria-label` and `title` for assistive technology
 * and tooltip display.
 *
 * Supports three visual variants (`primary`, `secondary`, `ghost`) driven by
 * the companion CSS Module (`IconButton.module.less`).
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.less';

/**
 * Props for the {@link IconButton} component.
 *
 * Extends all standard HTML button attributes so consumers may pass event
 * handlers, `type`, `disabled`, `data-*` attributes, etc.
 */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon(s) to render inside the button (e.g. an SVG component). */
  children: ReactNode;
  /**
   * Accessible name for the button. Used as both `aria-label` (screen-readers)
   * and `title` (hover tooltip).
   */
  label: string;
  /**
   * Visual style variant.
   * - `primary`   – filled, for prominent actions
   * - `secondary` – tinted, for subdued actions
   * - `ghost`     – transparent, for low-emphasis actions (default)
   */
  variant?: 'primary' | 'secondary' | 'ghost';
}

/**
 * Renders an icon-only button with a textual label for accessibility.
 *
 * @example
 * import { IconButton } from './IconButton';
 * import { PlusIcon } from './icons';
 *
 * <IconButton label="Add item" variant="primary" onClick={handleAdd}>
 *   <PlusIcon />
 * </IconButton>
 *
 * @param props - See {@link IconButtonProps}.
 */
export function IconButton({
  children,
  label,
  // Default to ghost so the button blends in when no variant is specified.
  variant = 'ghost',
  // Allow callers to extend the button’s CSS class list.
  className = '',
  ...props,
}: IconButtonProps) {
  return (
    <button
      // Expose the text label to assistive technology.
      aria-label={label}
      // Show a native tooltip on hover.
      title={label}
      // Compose the base button style, the variant-specific style, and any
      // caller-supplied classes into a single className string.
      className={`${styles.button} ${styles[variant]} ${className}`}
      {/* Forward all remaining standard button props */}
      {...props}
    >
      {children}
    </button>
  );
}
