/**
 * @fileoverview 消息气泡组件 —— 渲染单条聊天消息（用户或 AI）。
 *
 * 功能要点：
 * - 用户消息以纯文本展示，AI 消息支持 Markdown（GFM）渲染。
 * - 支持流式生成中间的“正在输入”指示器。
 * - 支持错误状态展示、引用列表、朗读按钮。
 *
 * 视觉上与 MessageBubble.module.less 联动，通过 CSS Modules 按角色、状态切换样式。
 *
 * @module components/chat/MessageBubble
 */

import { useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../../types/chat';
import { MessageAvatar } from './MessageAvatar';
import { TypingIndicator } from './TypingIndicator';
import styles from './MessageBubble.module.less';

/** 消息气泡组件的 props 定义 */
interface MessageBubbleProps {
  /** 消息数据对象 */
  message: Message;
  /** 是否为当前对话的最后一条消息（用于判断流式状态等） */
  isLast: boolean;
  /** 朗读/停止回调，仅在 AI 消息、有内容、非流式时展示对应的按钮 */
  onReadAloud?: (messageId: string, text: string) => void;
  /** 这条消息是否正在朗读（决定按钮显示「朗读」还是「停止」）。 */
  isReading?: boolean;
  /** 右侧引用面板当前是否展示的正是这条消息的引用。 */
  isReferencesTarget?: boolean;
  /** 点击「引用 N 条」时调用，把右侧面板切到这一轮。 */
  onShowReferences?: (messageId: string) => void;
}

/**
 * 消息气泡组件
 *
 * 负责渲染一条聊天消息，包括头像、气泡正文、引用、朗读按钮、时间戳等。
 * 使用 React.memo 包裹，仅当消息内容、流式状态或错误发生变化时才重渲染，
 * 避免流式输出时已完成的历史消息跟着无意义重渲染。
 *
 * 流式输出期间使用纯文本渲染（跳过 ReactMarkdown 的 remark → rehype 解析管线），
 * 流式结束后再切换为完整的 Markdown 渲染，避免 O(n²) 级别的重复解析。
 *
 * @param props - 见 {@link MessageBubbleProps}
 * @returns 消息气泡 JSX 元素
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  isLast,
  onReadAloud,
  isReading,
  isReferencesTarget,
  onShowReferences,
}: MessageBubbleProps) {
  // 当前消息是否由用户发送
  const isUser = message.role === 'user';
  // 仅当消息是最后一条 且 正在流式生成时才展示流式状态
  const isStreaming = !!(message.isStreaming && isLast);

  // 将 ISO 时间戳格式化为中文时间（HH:mm），并使用 useMemo 避免每次渲染都重新格式化
  const formattedTime = useMemo(() => {
    return new Date(message.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [message.timestamp]);

  return (
    // messageRow：基础行容器；messageRowUser：用户消息时水平翻转（头像在右）
    // animate-slide-up：全局入场动画类名
    <div className={`${styles.messageRow} ${isUser ? styles.messageRowUser : ''} animate-slide-up`}>
      {/* 头像（根据 role 自动切换用户/AI 图标） */}
      <MessageAvatar role={message.role} />

      {/* 气泡内容区域 */}
      <div className={`${styles.bubbleWrapper} ${isUser ? styles.bubbleWrapperUser : ''}`}>
        {/* 气泡容器：根据角色和错误状态组合样式类名 */}
        <div
          className={`${styles.bubble}
            ${isUser ? styles.userBubble : styles.aiBubble}
            ${message.error ? styles.errorBubble : ''}
          `}
        >
          {/* 用户消息：附件标签 + 纯文本（保留换行与空白） */}
          {isUser ? (
            <>
              {/*
                附件标签。`fileName` / `fileId` 一直都记在消息上（见 types/chat.ts
                的 Message），但这里从来没渲染过 —— 结果是文件发出去之后，从列表里
                完全看不出这条消息带了什么、AI 是就着哪份文件回答的。
                fileId 不上屏：它只是内部 ID（uuid 前 8 位），对用户没有意义。
              */}
              {message.fileName && (
                <span className={styles.fileChip} title={message.fileName}>
                  📎 <span className={styles.fileName}>{message.fileName}</span>
                </span>
              )}
              <p className={styles.messageText}>{message.content}</p>
            </>
          ) : isStreaming ? (
            // 流式输出中：纯文本渲染，跳过 ReactMarkdown 避免逐 token 重复解析
            <p className={`markdown-content ${styles.markdownBody}`}>
              {message.content}
              <span className={styles.streamingCursor} />
            </p>
          ) : message.stopped && !message.content ? (
            // 点了「停止生成」且一个字都没收到 —— 渲染空 Markdown 会留下一个
            // 空白气泡，看起来像界面坏了。直接给一句说明。
            <p className={styles.stoppedText}>已停止生成</p>
          ) : (
            <>
              {/* 流式结束后：完整 Markdown 渲染（GFM） */}
              <div className={`markdown-content ${styles.markdownBody}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
              {/* 答到一半被中断：必须显式标出来。育儿/医疗建议被截断后，
                  看上去和一条完整结论没有区别，容易误导。 */}
              {message.stopped && <p className={styles.stoppedText}>已停止生成</p>}
            </>
          )}

          {/* 错误提示：仅当 message.error 非空时渲染 */}
          {message.error && (
            <p className={styles.errorText}>⚠️ {message.error}</p>
          )}
        </div>

        {/*
          消息操作行：引用入口 + 朗读。
          引用正文不塞回气泡（会把气泡撑得很长），但**入口必须留在这里** ——
          右侧面板一次只能显示一轮，没有这个入口，前面几轮检索到的来源就再也找不到了。
        */}
        {!isUser && !isStreaming && (
          ((message.references?.length ?? 0) > 0 || (message.content && onReadAloud)) && (
            <div className={styles.messageActions}>
              {(message.references?.length ?? 0) > 0 && (
                <button
                  onClick={() => onShowReferences?.(message.id)}
                  className={`${styles.referenceChip} ${isReferencesTarget ? styles.referenceChipActive : ''}`}
                  aria-pressed={Boolean(isReferencesTarget)}
                  title={isReferencesTarget ? '右侧正在显示这条回答的引用' : '在右侧查看这条回答的引用来源'}
                >
                  📚 引用 {message.references!.length} 条
                </button>
              )}

              {/* 朗读/停止：同一个按钮做开关。正在读的这条显示「停止」，
                  点一下立即 cancel 掉整条队列（长回答会被切成多块排队播放）。 */}
              {message.content && onReadAloud && (
                <button
                  onClick={() => onReadAloud(message.id, message.content)}
                  className={`${styles.readAloudButton} ${isReading ? styles.readAloudButtonActive : ''}`}
                  aria-pressed={Boolean(isReading)}
                  title={isReading ? '停止朗读' : '朗读此消息'}
                >
                  {isReading ? '⏹ 停止' : '🔊 朗读'}
                </button>
              )}
            </div>
          )
        )}

        {/* 流式生成指示器：流式进行中但尚无内容时展示"正在输入…"动画 */}
        {isStreaming && !message.content && <TypingIndicator />}

        {/* 消息时间戳 */}
        <span className={styles.timestamp}>
          {formattedTime}
        </span>
      </div>
    </div>
  );
});
