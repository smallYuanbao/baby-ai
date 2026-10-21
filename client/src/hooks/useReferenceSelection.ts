/**
 * @fileoverview 引用面板的「当前轮次」选择逻辑。
 *
 * 面板常驻右侧、一次只能显示一轮的引用，所以必须回答两个问题：
 *   1. **默认看哪一轮？** —— 最新一轮（含尚在检索、引用还为空的那条占位消息）。
 *      不能像旧实现那样「倒着找最近一条有引用的消息」：新一轮检索期间会继续
 *      挂着上一轮的来源，用户看到「思考中」配上一轮的引用，两边对不上。
 *   2. **怎么看之前的轮次？** —— 由消息上的「引用 N 条」触发 `select`。
 *
 * 单独抽出来是因为这是纯状态推导，和布局无关：既能在 ChatContainer 里用，
 * 也能在预览页里用真实数据跑一遍，不必把整条聊天链路拉起来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../types/chat';

export interface ReferenceSelection {
  /** 当前选中的助手消息 id。 */
  selectedId: string | null;
  /** 当前选中的助手消息；对话被清空后为 null。 */
  selectedMessage: Message | null;
  /** 把面板切到指定消息（消息上的「引用 N 条」调用）。 */
  select: (messageId: string) => void;
}

export function useReferenceSelection(messages: Message[]): ReferenceSelection {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** 最新一条助手消息的 id（含流式占位）。 */
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  // 新一轮开始（出现了新的助手消息）时把面板拉回最新一轮。
  // 用 ref 记住上一次的值：流式期间 messages 每个 token 都会变，但
  // lastAssistantId 不变 —— 不该反复 setState，把正在翻历史引用的用户拽走。
  const prevLastAssistantIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastAssistantId && lastAssistantId !== prevLastAssistantIdRef.current) {
      prevLastAssistantIdRef.current = lastAssistantId;
      setSelectedId(lastAssistantId);
    }
  }, [lastAssistantId]);

  const selectedMessage = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.id === selectedId) ?? null,
    [messages, selectedId],
  );

  const select = useCallback((messageId: string) => setSelectedId(messageId), []);

  return { selectedId, selectedMessage, select };
}
