/**
 * format.ts — 前端格式化工具集
 *
 * 本文件提供一组纯函数，用于将后端返回的原始数据转换为面向用户展示的友好格式。
 * 所有函数均为无副作用的纯函数，可在组件、管道、computed 等任何上下文中安全调用。
 *
 * 职责范围：
 * - 时间戳 → 相对时间描述（中文）
 * - 相关性数值 → 百分比字符串
 * - 长文本 → 截断摘要
 *
 * @module format
 */
/**
 * 将 Unix 毫秒时间戳格式化为中文相对时间描述。
 *
 * @description
 * 根据时间差选择展示粒度：
 * - < 60 秒 → "刚刚"
 * - < 60 分钟 → "X分钟前"
 * - < 24 小时 → "X小时前"
 * - < 7 天   → "X天前"
 * - >= 7 天  → 回退到绝对日期（如 "6月19日"）
 *
 * @param timestamp - Unix 毫秒级时间戳，例如 `Date.now()` 或 `Date.parse()` 的返回值
 * @returns 中文相对时间字符串
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  // 计算时间差（毫秒），用于判断距现在的远近
  const diff = now - timestamp;

  // 逐级向下取整，得到秒/分钟/小时/天的整数差
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // 按粒度从细到粗依次匹配，首个命中的分支即为展示文案
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;

  // 超过 7 天的内容使用绝对日期，区域设为 zh-CN 以获得中文月份缩写
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * 将 0~1 范围的相关性/置信度分数转换为百分比字符串。
 *
 * @description
 * 典型的输入来自后端语义搜索或推荐系统的 `_score` 字段，
 * 值为 0 到 1 之间的小数。函数将其放大 100 倍后四舍五入取整，
 * 再拼接 "%" 符号。例如 `0.8765` → `"88%"`。
 *
 * @param score - 相关性分数，范围 [0, 1]
 * @returns 不带空格的百分比字符串，如 `"88%"`
 */
export function formatScore(score: number): string {
  // Math.round 保证结果最接近真实百分比，避免 Math.floor 引入的向下偏差
  return `${Math.round(score * 100)}%`;
}

/**
 * 将超出指定长度的文本截断并追加省略号。
 *
 * @description
 * 常用于搜索结果摘要、卡片预览等对显示空间敏感的场景。
 * 当 `text` 长度未超过 `maxLength` 时原样返回；
 * 超过时截取前 `maxLength` 个字符（按 `.length` 计算，即 UTF-16 码元数），
 * 尾部拼接英文省略号 `"..."`。
 *
 * @param text - 原始文本
 * @param maxLength - 截断阈值（字符数），超过此长度的文本会被截断
 * @returns 未超长则返回原文本；超长则返回截断后带 "..." 的字符串
 */
export function truncateText(text: string, maxLength: number): string {
  // 未超长时无需处理，直接返回避免不必要的字符串拷贝
  if (text.length <= maxLength) return text;
  // slice(0, maxLength) 取前 maxLength 个字符，尾部拼接省略号作为视觉提示
  return text.slice(0, maxLength) + '...';
}
