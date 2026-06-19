/**
 * GrowthRecordList Component
 *
 * Renders a chronological list of baby growth records with inline tags for
 * height, weight, head circumference, sleep duration, diaper count, feeding,
 * and optional notes. Supports adding a new record and editing existing ones.
 *
 * @file client/src/components/growth/GrowthRecordList.tsx
 */

import type { GrowthRecord } from '../../types/growth';
import styles from './GrowthRecordList.module.less';

/**
 * Props accepted by the {@link GrowthRecordList} component.
 */
interface GrowthRecordListProps {
  /** Array of growth records to display (unsorted — the component sorts them). */
  records: GrowthRecord[];
  /** Callback fired when the user taps the "+" / add button. */
  onAdd: () => void;
  /** Callback fired when the user taps a specific record to edit it. */
  onEdit: (record: GrowthRecord) => void;
}

/**
 * Format a feeding object into a single human-readable string.
 *
 * Maps the feeding type to a locale-friendly label with an emoji prefix,
 * appending the amount and unit when present.
 *
 * @param feeding - The feeding sub-object from a {@link GrowthRecord}.
 * @returns A formatted string like "🤱母乳 120ml", or an empty string when
 *          feeding is falsy.
 */
function formatFeeding(feeding: GrowthRecord['feeding']): string {
  if (!feeding) return '';
  const typeMap: Record<string, string> = { breast: '🤱母乳', formula: '🍼配方奶', solid: '🥄辅食', mixed: '🍽混合' };
  const type = typeMap[feeding.type] || feeding.type;
  const amount = feeding.amount ? ` ${feeding.amount}${feeding.unit || ''}` : '';
  return type + amount;
}

/**
 * GrowthRecordList — the main list component for growth records.
 *
 * Behaviour:
 * 1. Sort records by date descending (newest first).
 * 2. Render a top bar with a record count and an "add" button.
 * 3. If no records exist, show an empty-state placeholder.
 * 4. Otherwise, render a scrollable list of record cards, each displaying
 *    relevant metrics as coloured tags and any free-text notes.
 *
 * @param props - See {@link GrowthRecordListProps}.
 */
export function GrowthRecordList({ records, onAdd, onEdit }: GrowthRecordListProps) {
  // Newest records appear first.
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className={styles.wrapper}>
      {/* ── Top bar: count + add button ── */}
      <div className={styles.topBar}>
        <span className={styles.recordCount}>共 {records.length} 条记录</span>
        <button
          onClick={onAdd}
          className={styles.addButton}
        >
          + 添加
        </button>
      </div>

      {/* ── Content: empty state or record list ── */}
      {sorted.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📋</span>
          <p className={styles.emptyText}>还没有成长记录</p>
          <p className={styles.emptyHint}>点击"添加"记录宝宝的成长数据</p>
        </div>
      ) : (
        <div className={styles.list}>
          {sorted.map((record) => (
            <button
              key={record.id}
              onClick={() => onEdit(record)}
              className={styles.recordItem}
            >
              {/* Record header: date + edit cue */}
              <div className={styles.recordHeader}>
                <span className={styles.recordDate}>📅 {record.date}</span>
                <span className={styles.editHint}>点击编辑 →</span>
              </div>

              {/* Metric tags — each only renders when the value is present */}
              <div className={styles.tags}>
                {record.height && (
                  <span className={`${styles.tag} ${styles.tagBlue}`}>📏 {record.height}cm</span>
                )}
                {record.weight && (
                  <span className={`${styles.tag} ${styles.tagGreen}`}>⚖ {record.weight}kg</span>
                )}
                {record.headCircumference && (
                  <span className={`${styles.tag} ${styles.tagPurple}`}>📐 {record.headCircumference}cm</span>
                )}
                {record.sleepDuration && (
                  <span className={`${styles.tag} ${styles.tagIndigo}`}>😴 {record.sleepDuration}h</span>
                )}
                {/* diaper count: explicitly check !== undefined because 0 is a valid value */}
                {record.diapers !== undefined && (
                  <span className={`${styles.tag} ${styles.tagAmber}`}>🧷 {record.diapers}次</span>
                )}
                {record.feeding && (
                  <span className={`${styles.tag} ${styles.tagPink}`}>
                    {formatFeeding(record.feeding)}
                  </span>
                )}
              </div>

              {/* Free-text notes, single-line ellipsis */}
              {record.notes && (
                <p className={styles.notes}>💬 {record.notes}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
