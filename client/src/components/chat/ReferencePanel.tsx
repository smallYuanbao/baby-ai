/**
 * @file ReferencePanel.tsx
 * @description 右侧引用面板(桌面端三栏布局的第三栏)。
 *
 * 为什么单独拿出来:这是 **RAG 应用特有**的信息——「这个回答是基于哪几段证据生成的」。
 * 塞在聊天气泡里时,它会把气泡撑得很长、打断对话的阅读节奏;
 * 单独成栏后,它可以一直挂在那儿,随最新一条回答更新,不干扰对话流。
 *
 * 常驻右侧第三栏（见 AppShell / ChatContainer）。
 */

import type { Reference } from '../../types/chat';
import { ReferenceCard } from './ReferenceCard';
import styles from './ReferencePanel.module.less';

interface ReferencePanelProps {
  /** 最新一条带引用的助手消息的引用；没有则展示空态。 */
  references: Reference[];
  /**
   * 最新一条助手回答是否还在流式生成中。
   *
   * **必须先于 hasAnswer 判断**：检索要几十秒，这期间助手消息已经存在但引用还没到，
   * 如果直接落到"没用到知识库"那条兜底文案上，用户会以为模型已经放弃检索了。
   */
  isStreaming: boolean;
  /**
   * 当前对话里是否已经存在助手回答（含正在生成的那条）。
   *
   * 用来区分两种"引用为空"：
   *   - 还没提问 → 介绍这一栏是干什么的；
   *   - 答完了但没检索到相关内容（后端相关性门控把无关文档丢掉了）→ 说明这次回答
   *     没用到知识库，否则会显示"提问后,这里会显示…"，可明明已经问过了。
   */
  hasAnswer: boolean;
}

export function ReferencePanel({ references, isStreaming, hasAnswer }: ReferencePanelProps) {
  return (
    <aside className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>引用来源</h2>
        {references.length > 0 && <span className={styles.count}>{references.length} 条</span>}
      </div>

      {references.length > 0 ? (
        <div className={styles.list}>
          {references.map((r, i) => (
            <ReferenceCard key={`${r.id}-${i}`} reference={r} index={i + 1} />
          ))}
        </div>
      ) : isStreaming ? (
        // 检索要几十秒。这期间"引用为空"是正常的中间态，不是结论 ——
        // 直接显示下面那条兜底文案会让用户以为模型没检索到东西。
        <p className={styles.empty}>正在检索知识库…</p>
      ) : hasAnswer ? (
        <p className={styles.empty}>
          本次回答没有用到知识库内容 —— 问题可能不在知识库覆盖的育儿范围内，
          答案来自模型自身的知识，请结合常识判断。
        </p>
      ) : (
        <p className={styles.empty}>
          提问后,这里会显示本次回答检索到的知识库片段——
          它们就是答案的依据,可以据此判断回答是否可信。
        </p>
      )}
    </aside>
  );
}
