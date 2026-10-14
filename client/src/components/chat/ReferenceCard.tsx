/**
 * @file ReferenceCard.tsx
 * @description RAG citation card displayed alongside an assistant message.
 *
 * Each ReferenceCard renders a single knowledge-base hit returned by the
 * retrieval-augmented generation pipeline.  It shows the reference number
 * in a branded badge, the source document title, a relevancy score via
 * {@link ScoreBadge}, and a truncated snippet preview.
 *
 * The component is intentionally lightweight — it delegates score rendering
 * to the shared {@link ScoreBadge} and relies on CSS Modules for all
 * visual presentation so it can be composed freely inside a chat bubble
 * without leaking styles.
 */

import type { Reference } from '../../types/chat';
import { ScoreBadge } from '../shared/ScoreBadge';
import styles from './ReferenceCard.module.less';

/**
 * Props for the {@link ReferenceCard} component.
 *
 * Accepts a single RAG reference object containing the citation's numeric
 * identifier, source title, supporting excerpt, and relevance score (0–1).
 */
interface ReferenceCardProps {
  /** The RAG reference to render — sourced from an assistant {@link Message}. */
  reference: Reference;
  /**
   * 该引用在列表中的序号（从 1 开始），显示在左侧徽章里。
   *
   * 不用 `reference.id`：那是 ChromaDB 的分块 ID（形如 `med_32ce4015`），
   * 又长又没有阅读意义，塞进 24px 的方块里会被挤爆。
   */
  index: number;
}

/**
 * Renders a compact citation card for a RAG knowledge-base hit.
 *
 * Layout: a fixed-size rounded badge on the left (reference number) followed
 * by a flexible body containing the title + score header and a two-line
 * text snippet below.
 *
 * @param props - Component props (see {@link ReferenceCardProps}).
 * @returns A styled citation card element.
 */
export function ReferenceCard({ reference, index }: ReferenceCardProps) {
  return (
    <div className={styles.card}>
      {/* Reference number badge — uses the brand primary colour as background */}
      <span className={styles.badge}>
        {index}
      </span>

      {/* Body: title row with score badge, then clipped snippet */}
      <div className={styles.body}>
        <div className={styles.header}>
          {/* Title is single-line, ellipsised on overflow */}
          <h4 className={styles.title}>
            {reference.title}
          </h4>
          {/* ScoreBadge visualises the 0–1 relevance score as a colour-coded label.
              精排缺失时 score 为 undefined，此时宁可不显示，也不显示一个假的分数。 */}
          {reference.score !== undefined && <ScoreBadge score={reference.score} />}
        </div>
        {/* Snippet is clamped to 2 lines via -webkit-line-clamp */}
        <p className={styles.snippet}>
          {reference.snippet}
        </p>
      </div>
    </div>
  );
}
