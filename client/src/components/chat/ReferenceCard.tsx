/**
 * @file ReferenceCard.tsx
 * @description RAG citation card displayed alongside an assistant message.
 *
 * Each ReferenceCard renders a single knowledge-base hit returned by the
 * retrieval-augmented generation pipeline.  It shows the reference number
 * in a branded badge, the source document title, a relevancy score via
 * {@link ScoreBadge}, and the full supporting text.
 *
 * **默认展开**：引用面板存在的意义就是让人核对「这句话到底有没有依据」，
 * 藏起来再点一下才能看全，等于把最重要的信息设成了次要点。
 * 内容太长时仍可手动「收起」成两行预览，方便快速扫过五条。
 *
 * 展开/折叠用的是**两套互斥的类**（`.title` / `.titleClamped`，
 * `.snippet` / `.snippetClamped`），而不是「基础类 + 覆盖类」。
 * 覆盖式写法依赖选择器顺序和 `-webkit-line-clamp: unset` 的跨浏览器行为，
 * 一旦某处没覆盖上，表现就是「点了展开还是两行」—— 正是之前踩过的坑。
 */

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Reference } from '../../types/chat';
import { ScoreBadge } from '../shared/ScoreBadge';
import styles from './ReferenceCard.module.less';

/**
 * 把 Markdown 压成一行纯文本，只给**收起态**的两行预览用。
 *
 * 语料里的 chunk 带着 `**加粗**`、`# 标题`、`- 列表` 这些标记；直接塞进
 * 两行预览里会露出一堆星号和井号，比不显示还乱。展开态走真正的 Markdown 渲染，
 * 不需要这个函数。
 */
function toPlainPreview(markdown: string): string {
  return markdown
    .replace(/^[-*_]{3,}\s*$/gm, '')   // 分割线：不处理会在预览里露出一串 "---"
    .replace(/\*\*(.+?)\*\*/g, '$1')   // 加粗
    .replace(/__(.+?)__/g, '$1')       // 加粗（下划线写法）
    .replace(/~~(.+?)~~/g, '$1')       // 删除线
    .replace(/`([^`]+)`/g, '$1')       // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → 只留 alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // 链接 → 只留文字
    .replace(/^#{1,6}\s+/gm, '')       // 标题标记
    .replace(/^>\s?/gm, '')            // 引用标记
    .replace(/^\s*[-*+]\s+/gm, '')     // 无序列表标记
    .replace(/^\s*\d+\.\s+/gm, '')     // 有序列表标记
    .replace(/\s+/g, ' ')              // 折叠换行：预览只有两行，保留换行没意义
    .trim();
}

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
 * Renders a citation card for a RAG knowledge-base hit.
 *
 * Layout: a fixed-size rounded badge on the left (reference number) followed
 * by a flexible body containing the title + score header and the supporting
 * text below. Full text is shown by default; the user may collapse it.
 *
 * @param props - Component props (see {@link ReferenceCardProps}).
 * @returns A styled citation card element.
 */
export function ReferenceCard({ reference, index }: ReferenceCardProps) {
  /** 是否收起成两行预览。默认 false —— 完整内容先摆出来。 */
  const [collapsed, setCollapsed] = useState(false);

  /** 收起态预览用的纯文本。只在收起时才算，展开时不浪费这次字符串处理。 */
  const plainPreview = useMemo(
    () => (collapsed ? toPlainPreview(reference.snippet) : ''),
    [collapsed, reference.snippet],
  );

  return (
    <div className={styles.card}>
      {/* Reference number badge — uses the brand primary colour as background */}
      <span className={styles.badge}>
        {index}
      </span>

      {/* Body: title row with score badge, then the supporting text */}
      <div className={styles.body}>
        <div className={styles.header}>
          <h4 className={collapsed ? styles.titleClamped : styles.title}>
            {reference.title}
          </h4>
          {/* ScoreBadge visualises the 0–1 relevance score as a colour-coded label.
              精排缺失时 score 为 undefined，此时宁可不显示，也不显示一个假的分数。 */}
          {reference.score !== undefined && <ScoreBadge score={reference.score} />}
        </div>

        {collapsed ? (
          // 收起态：纯文本两行预览（Markdown 标记已剥离）
          <p className={styles.snippetClamped}>{plainPreview}</p>
        ) : (
          // 展开态：按 Markdown 渲染。语料里的加粗、列表、表格本来就是给人看的，
          // 当纯字符串输出会把 `**` 和空行原样暴露出来。
          // react-markdown 默认不执行原始 HTML，引用的正文不会被当成可执行内容。
          <div className={`markdown-content ${styles.markdown}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{reference.snippet}</ReactMarkdown>
          </div>
        )}

        <button
          type="button"
          className={styles.toggle}
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? '展开全文' : '收起'}
        </button>
      </div>
    </div>
  );
}
