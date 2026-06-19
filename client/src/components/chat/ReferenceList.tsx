/**
 * ReferenceList — A collapsible panel that displays a list of reference sources
 * (documents, URLs, etc.) cited by the AI in a chat response.
 *
 * The list is hidden when there are no references and collapsed by default when
 * references are present. The user toggles visibility via a chevron button that
 * also shows the reference count.
 */

import { useState } from 'react';
import type { Reference } from '../../types/chat';
import { ReferenceCard } from './ReferenceCard';
import styles from './ReferenceList.module.less';

/** Props accepted by the ReferenceList component. */
interface ReferenceListProps {
  /** Array of reference objects to display. */
  references: Reference[];
}

/**
 * Renders a toggleable list of reference sources for a chat message.
 *
 * Behaviour:
 * - Returns `null` when `references` is empty (renders nothing).
 * - Closed by default; the user clicks the toggle button to expand or collapse.
 * - When expanded, each reference is rendered via `ReferenceCard` with a fade-in
 *   animation.
 */
export function ReferenceList({ references }: ReferenceListProps) {
  // Closed by default — the panel is hidden until the user explicitly expands it.
  const [isOpen, setIsOpen] = useState(false);

  // Do not render anything when there are no references to show.
  if (references.length === 0) return null;

  return (
    <div className={styles.wrapper}>
      {/* Toggle button — shows the reference count and a rotating chevron icon. */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={styles.toggleButton}
      >
        {/* Chevron icon: rotates 90° clockwise when the panel is open. */}
        <svg
          className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        参考来源 ({references.length})
      </button>

      {/* Reference list body — only rendered when the panel is expanded. */}
      {isOpen && (
        <div className={`${styles.referenceList} animate-fade-in`}>
          {references.map((ref) => (
            <ReferenceCard key={ref.id} reference={ref} />
          ))}
        </div>
      )}
    </div>
  );
}
