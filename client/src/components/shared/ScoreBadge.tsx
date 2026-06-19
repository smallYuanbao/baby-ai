/**
 * ScoreBadge — 相关性评分徽章组件。
 *
 * 根据 0-1 的分数展示三段式语义：高相关（≥0.85）、中等（≥0.7）、一般（<0.7），
 * 并附带色点指示与百分比文字。
 *
 * @file client/src/components/shared/ScoreBadge.tsx
 */

import styles from './ScoreBadge.module.less';

/**
 * ScoreBadge 组件的 Props。
 */
interface ScoreBadgeProps {
  /** 相关性分数，取值范围 0-1（含）。 */
  score: number; // 0-1
}

/**
 * 根据分数返回对应的 CSS Module 类名，用于着色。
 *
 * @param score - 0-1 之间的相关性分数
 * @returns 对应 high / medium / low 的样式类名
 */
function getColorClass(score: number): string {
  if (score >= 0.85) return styles.high;
  if (score >= 0.7) return styles.medium;
  return styles.low;
}

/**
 * 根据分数返回中文语义标签。
 *
 * @param score - 0-1 之间的相关性分数
 * @returns “高相关” / “中等” / “一般”
 */
function getLabel(score: number): string {
  if (score >= 0.85) return '高相关';
  if (score >= 0.7) return '中等';
  return '一般';
}

/**
 * 评分徽章组件。
 *
 * 展示一个内联的色点 + 语义标签 + 百分比数值，
 * 颜色由分数所处的区间决定。
 */
export function ScoreBadge({ score }: ScoreBadgeProps) {
  // 将 0-1 分数转为 0-100 整数百分比
  const percentage = Math.round(score * 100);

  return (
    <span
      className={`${styles.badge} ${getColorClass(score)}`}
      title={`相关性: ${percentage}%`}
    >
      {/* 色点指示器 */}
      <span className={styles.dot} />
      {/* 中文语义标签 */}
      {getLabel(score)}
      {/* 百分比数值 */}
      <span className={styles.percent}>{percentage}%</span>
    </span>
  );
}
