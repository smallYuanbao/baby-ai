/**
 * @fileoverview 历史会话列表（抽屉内容）。
 *
 * 纯展示组件：数据、当前选中项、加载状态都由 ChatContainer 提供，
 * 这样它可以脱离聊天逻辑单独渲染/验证。
 *
 * 删除放在这里、而不是工具栏的「新对话」上 —— 「新对话」只是开一个新会话，
 * 旧对话会留在历史里；要真正抹掉一段对话，入口必须是它自己的那一行。
 */

import { Popconfirm } from 'antd';
import type { SessionSummary } from '../../services/api';
import styles from './SessionList.module.less';

interface SessionListProps {
  /** 会话列表（服务端已按最近活动倒序排好）。 */
  sessions: SessionSummary[];
  /** 当前正在查看的会话 id，用于高亮。 */
  activeSessionId: string | null;
  /** 是否正在加载列表。 */
  loading: boolean;
  /** 点击某条历史会话。 */
  onSelect: (sessionId: string) => void;
  /** 删除某条历史会话。 */
  onDelete: (sessionId: string) => void;
  /** 开一段新对话。 */
  onNewSession: () => void;
}

/** ISO 时间 → `10/17 16:06`；解析失败返回空串（不显示假时间）。 */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SessionList({
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onDelete,
  onNewSession,
}: SessionListProps) {
  return (
    <div className={styles.wrapper}>
      <button type="button" className={styles.newSession} onClick={onNewSession}>
        ＋ 新对话
      </button>

      <div className={styles.list}>
        {loading ? (
          <p className={styles.state}>加载中…</p>
        ) : sessions.length === 0 ? (
          <p className={styles.state}>还没有历史会话</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.sessionId}
              className={`${styles.itemRow} ${
                session.sessionId === activeSessionId ? styles.itemActive : ''
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(session.sessionId)}
                className={styles.item}
              >
                <span className={styles.title}>{session.title}</span>
                <span className={styles.meta}>
                  {session.messageCount} 条 · {formatUpdatedAt(session.updatedAt)}
                </span>
              </button>

              {/*
                删除是不可逆动作，用 Popconfirm 二次确认。
                用相对独立的按钮而不是把整行做成可删除区域：
                误触的代价是整段对话消失。
              */}
              <Popconfirm
                title="删除这段对话？"
                description="删除后无法恢复"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(session.sessionId)}
                placement="right"
              >
                <button
                  type="button"
                  className={styles.deleteButton}
                  title="删除这段对话"
                  aria-label={`删除会话：${session.title}`}
                >
                  🗑
                </button>
              </Popconfirm>
            </div>
          ))
        )}
      </div>

      {/*
        把保留上限写在界面上。超过上限后最早的对话会被删除，
        用户至少知道这是产品的规则，而不是以为"数据丢了"。
      */}
      <p className={styles.hint}>每个会话保留最近 50 轮对话</p>
    </div>
  );
}
