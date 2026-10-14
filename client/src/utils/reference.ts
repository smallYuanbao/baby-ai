/**
 * @file reference.ts
 * @description 把后端返回的引用条目归一化成界面用的 {@link Reference}。
 *
 * 为什么需要这一层：两边 schema 从来没对齐过。
 * 后端 `app/models/chat.py` 的 `Reference` 只有 `{id, text, score}` ——
 * 标题和正文全糊在一段 `text` 里；而引用卡片（ReferenceCard）要的是
 * `title` / `snippet` / `score` 三个字段。不做转换的话，卡片会渲染成
 * 一串 chunk id 加空白标题。
 *
 * 放在这里而不是后端：后端 `Reference` 被 5 处构造点共用（chat_service、
 * agent/base、agent/unified、mcp_client），改模型面太广；而「怎么展示」
 * 本来就是这个界面自己的事。
 */

import type { Reference } from '../types/chat';

/** 单条引用在 SSE 事件里的原始形状（字段都可能是任意类型，故用 unknown）。 */
interface RawReference {
  id?: unknown;
  text?: unknown;
  score?: unknown;
}

/** 标题的软上限：超过就尝试在句读/空白处切开，剩下的当摘要。 */
const TITLE_MAX_LENGTH = 40;

/** 摘要展示上限，避免把整篇文档塞进 DOM（卡片本来也只显示两行）。 */
const SNIPPET_MAX_LENGTH = 300;

/**
 * 从后端拼好的 `text` 里拆出标题和正文。
 *
 * 语料里见过三种排布，都要能接住：
 *   1. `【儿科其他】宝宝晚上哭啼怎么办\n问：…\n答：…`  ← 主语料（med_* 文档）
 *   2. `宝宝发烧护理指南（内部测试文档） 当宝宝体温超过 38.5 度时，…` ← 单行无换行
 *   3. `问题：宝宝打完疫苗后发烧…？  回答：…`              ← 单行无换行
 *
 * 策略：优先按第一个换行切；单行时再按句读/空白切出前半段当标题。
 * 切不出来就整段当标题、摘要留空（宁可少显示，也不硬猜）。
 */
function splitTitleAndBody(text: string): { title: string; body: string } {
  const clean = text.replace(/\r/g, '').trim();
  const firstBreak = clean.indexOf('\n');

  // 情况 1：有换行 —— 首行就是标题
  if (firstBreak !== -1) {
    const title = clean.slice(0, firstBreak).trim();
    const body = clean.slice(firstBreak + 1).trim();
    return { title, body };
  }

  // 单行且不长 —— 整行当标题
  if (clean.length <= TITLE_MAX_LENGTH) {
    return { title: clean, body: '' };
  }

  // 单行且过长 —— 在软上限内找最后一个句读或空白作为切点
  const head = clean.slice(0, TITLE_MAX_LENGTH);
  const cut = Math.max(
    head.lastIndexOf('】'),
    head.lastIndexOf('。'),
    head.lastIndexOf('？'),
    head.lastIndexOf('！'),
    head.lastIndexOf('，'),
    head.lastIndexOf(' '),
  );

  // cut 为 -1（一个切点都没有）时退回整段当标题
  if (cut <= 0) {
    return { title: clean.slice(0, TITLE_MAX_LENGTH).trim(), body: clean.slice(TITLE_MAX_LENGTH).trim() };
  }

  // '】' 是语料里的分类前缀（【儿科其他】），属于标题的一部分，切点在它之后
  const cutAt = head[cut] === '】' ? cut + 1 : cut;
  return { title: clean.slice(0, cutAt).trim(), body: clean.slice(cutAt).trim() };
}

/** 摘要超长时截断并加省略号。 */
function toSnippet(body: string, fallback: string): string {
  const source = body || fallback;
  if (source.length <= SNIPPET_MAX_LENGTH) return source;
  return `${source.slice(0, SNIPPET_MAX_LENGTH)}…`;
}

/**
 * 把 SSE 里的 references 负载归一化成界面用的 {@link Reference} 列表。
 *
 * 容错：负载可能是数组，也可能是 `{references: [...]}` 包裹；条目里缺 id/text
 * 时按空串处理而不是抛异常 —— 引用只是辅助信息，不该因为它让整条回答挂掉。
 *
 * @param raw - SSE `references` 事件的原始 data。
 * @returns 归一化后的引用列表；无法解析时返回空数组。
 */
export function normalizeReferences(raw: unknown): Reference[] {
  const list: unknown = Array.isArray(raw)
    ? raw
    : (raw as { references?: unknown } | null | undefined)?.references;

  if (!Array.isArray(list)) return [];

  return list.map((item, index) => {
    const entry = (item ?? {}) as RawReference;
    const text = typeof entry.text === 'string' ? entry.text : '';
    const { title, body } = splitTitleAndBody(text);

    return {
      // id 缺失时用下标兜底，保证 React key 稳定且唯一
      id: typeof entry.id === 'string' && entry.id ? entry.id : `ref-${index}`,
      title,
      snippet: toSnippet(body, text),
      // 只接受有限数字：后端可能给 null（工具引用）或 NaN
      score: typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : undefined,
    };
  });
}
