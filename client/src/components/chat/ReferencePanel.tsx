/**
 * @file ReferencePanel.tsx
 * @description 右侧引用面板(桌面端三栏布局的第三栏)。
 *
 * 为什么单独拿出来:这是 **RAG 应用特有**的信息——「这个回答是基于哪几段证据生成的」。
 * 塞在聊天气泡里时,它会把气泡撑得很长、打断对话的阅读节奏;
 * 单独成栏后,它可以一直挂在那儿,随最新一条回答更新,不干扰对话流。
 *
 * 只在桌面显示(≥1024px);窄屏仍用气泡内的折叠引用列表(见 MessageBubble)。
 */

import type { Reference } from '../../types/chat';
import { ReferenceCard } from './ReferenceCard';
import styles from './ReferencePanel.module.less';

interface ReferencePanelProps {
  /** 最新一条带引用的助手消息的引用;没有则不展示内容。 */
  references: Reference[];
}

export function ReferencePanel({ references }: ReferencePanelProps) {
  return (
    <aside className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>引用来源</h2>
        {references.length > 0 && <span className={styles.count}>{references.length} 条</span>}
      </div>

      {references.length === 0 ? (
        <p className={styles.empty}>
          提问后,这里会显示本次回答检索到的知识库片段——
          它们就是答案的依据,可以据此判断回答是否可信。
        </p>
      ) : (
        <div className={styles.list}>
          {references.map((r, i) => (
            <ReferenceCard key={`${r.id}-${i}`} reference={r} index={i + 1} />
          ))}
        </div>
      )}
    </aside>
  );
}
