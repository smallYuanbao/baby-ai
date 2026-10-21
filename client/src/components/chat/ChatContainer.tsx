/**
 * @file ChatContainer
 * @description Top-level chat layout component that orchestrates the chat experience.
 *
 * Composes useChat (message state / streaming / error / actions), useSpeechSynthesis
 * (TTS support / speak / stop), MessageList, ChatInput, and ErrorBanner into a
 * single full-height flex column.  Handles conditional rendering of the clear-chat
 * toolbar and error banner, and wires the "read aloud" callback through to the
 * speech-synthesis hook.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from 'antd';
import { useChat } from '../../hooks/useChat';
import { useReferenceSelection } from '../../hooks/useReferenceSelection';
import { api, type SessionSummary } from '../../services/api';
import { SessionList } from './SessionList';
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis';
import { MessageList } from './MessageList';
import { ChatInput } from '../input/ChatInput';
import { ErrorBanner } from '../shared/ErrorBanner';
import { ReferencePanel } from './ReferencePanel';
import { VoiceSettings } from '../shared/VoiceSettings';
import styles from './ChatContainer.module.less';

/**
 * Top-level chat layout component.
 *
 * Responsibilities:
 * - Delegates chat state management to {@link useChat}.
 * - Delegates TTS playback to {@link useSpeechSynthesis}.
 * - Renders a clear-chat toolbar (visible only when there are messages).
 * - Renders an error banner (visible only when an error is present).
 * - Renders the scrollable message list and the fixed-bottom input area.
 *
 * @returns A full-height flex container holding the chat UI.
 */
export function ChatContainer() {
  const {
    messages,
    isStreaming,
    error,
    sessionId,
    sendMessage,
    retryLast,
    clearChat,
    switchSession,
    stopGenerating,
  } = useChat();

  /**
   * 朗读音色与语速的用户偏好。
   *
   * 存在 localStorage 里：这两个是"一次调好、长期受用"的设置，
   * 每次刷新都重置回默认会让人反复调。空的 voiceName 表示自动挑选
   * （见 useSpeechSynthesis 的偏好列表）。
   */
  const [voiceName, setVoiceName] = useState<string>(() => {
    try {
      return localStorage.getItem('baby-ai-tts-voice') ?? '';
    } catch {
      return '';
    }
  });
  const [speechRate, setSpeechRate] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('baby-ai-tts-rate'));
      return Number.isFinite(saved) && saved > 0 ? saved : 0.9;
    } catch {
      return 0.9;
    }
  });

  const handleVoiceChange = useCallback((name: string) => {
    setVoiceName(name);
    try {
      localStorage.setItem('baby-ai-tts-voice', name);
    } catch {
      // 隐私模式等场景写不进去，不影响本次会话使用
    }
  }, []);

  const handleRateChange = useCallback((value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return;
    setSpeechRate(next);
    try {
      localStorage.setItem('baby-ai-tts-rate', String(next));
    } catch {
      // 同上
    }
  }, []);

  const {
    isSupported: ttsSupported,
    activeId: speakingMessageId,
    voices: ttsVoices,
    selectedVoiceName,
    speak,
    stop: stopSpeaking,
  } = useSpeechSynthesis({ voiceName, rate: speechRate });

  /** 语音设置行是否展开。 */
  const [ttsSettingsOpen, setTtsSettingsOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // 历史会话
  // ---------------------------------------------------------------------------
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  /**
   * 打开历史抽屉时**重新拉一次**列表，而不是挂在 mount 上。
   *
   * 会话标题来自首条用户消息、消息数/时间每轮都在变 —— 只在挂载时取一次，
   * 聊完回来看到的还是旧数据。列表很小，每次打开拉一次的成本可以忽略。
   */
  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    setLoadingSessions(true);
    api
      .listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, []);

  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      setHistoryOpen(false);
      void switchSession(nextSessionId);
    },
    [switchSession],
  );

  /**
   * 开新对话：clearChat 会轮换并持久化新的 session id。
   *
   * **不删除任何东西** —— 当前这段对话会留在历史列表里。
   * 想真正删除，走历史列表每一行的删除按钮。
   */
  const handleNewSession = useCallback(() => {
    setHistoryOpen(false);
    clearChat();
  }, [clearChat]);

  /** 删除一条历史会话；删的正好是当前会话时，顺势开一段新的。 */
  const handleDeleteSession = useCallback(
    (targetSessionId: string) => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== targetSessionId));
      api.deleteSession(targetSessionId).catch(() => {
        /* 删除失败：下次打开抽屉会重新拉到真实状态，不用在这里弹错 */
      });
      if (targetSessionId === sessionId) clearChat();
    },
    [sessionId, clearChat],
  );

  /**
   * 点「朗读」开始，再点一次「停止」就停 —— 同一个按钮做开关。
   *
   * 之前 `stop` 从头到尾没被调用过：一条几百字的回答开始朗读后停不下来，
   * 唯一的中断方式是去点另一条消息。这里把它接上，并按消息 id 区分是哪一条在读。
   */
  const handleReadAloud = useCallback(
    (messageId: string, text: string) => {
      if (!ttsSupported) return;
      if (speakingMessageId === messageId) {
        stopSpeaking();
        return;
      }
      speak(messageId, text);
    },
    [ttsSupported, speakingMessageId, speak, stopSpeaking],
  );

  /**
   * 引用面板跟随「当前选中的那一轮回答」。
   *
   * 旧实现是「倒着找最近一条**有引用**的助手消息」，于是新一轮还在检索时
   * （新消息存在但 references 还是空的），面板会继续挂着上一轮的引用 ——
   * 用户看到的是「思考中」配着上一轮的来源，两边对不上；而更早轮次的引用
   * 只存在消息对象里，界面上没有任何入口，等于永久丢失。
   *
   * 选择逻辑见 useReferenceSelection：默认自动跟随最新一轮，点历史消息上的
   * 「引用 N 条」可以把面板切回那一轮。
   */
  const { selectedId: selectedReferencesId, selectedMessage, select: handleShowReferences } =
    useReferenceSelection(messages);

  /** 面板头部显示「11:15 的回答」，把右侧和具体某一轮明确绑在一起。 */
  const selectedTime = useMemo(
    () =>
      selectedMessage
        ? new Date(selectedMessage.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : null,
    [selectedMessage],
  );

  /** Esc 关掉展开中的语音设置行。 */
  useEffect(() => {
    if (!ttsSettingsOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setTtsSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ttsSettingsOpen]);

  return (
    <div className={styles.wrapper}>
      {/* 左：聊天区（工具栏 / 消息 / 输入）；右：引用面板 */}
      <div className={styles.chatColumn}>
      {/* ---- Toolbar ---- */}
      {/*
        工具栏**常驻**：历史会话入口必须在空对话时也能点到 ——
        否则刷新后回到欢迎页，就再也没有入口打开之前的对话了。
        「清空对话」仍然只在有消息时出现。
      */}
      <div className={styles.toolbar}>
          {ttsSettingsOpen ? (
            <VoiceSettings
              voices={ttsVoices}
              voiceName={voiceName}
              selectedVoiceName={selectedVoiceName}
              rate={speechRate}
              onVoiceChange={handleVoiceChange}
              onRateChange={handleRateChange}
              onClose={() => setTtsSettingsOpen(false)}
            />
          ) : (
            <div className={styles.toolbarActions}>
              <button
                onClick={openHistory}
                className={styles.clearButton}
                title="查看历史会话"
              >
                🕘 历史会话
              </button>

              {/* 浏览器不支持语音合成时，这项设置没有意义，直接不显示 */}
              {ttsSupported && (
                <button
                  onClick={() => setTtsSettingsOpen(true)}
                  className={styles.clearButton}
                  title="调整朗读音色与语速"
                >
                  🔊 语音设置
                </button>
              )}

              {/*
                语义从「清空对话」改成「新对话」：
                现在对话会持久化，这个动作**不删除任何数据**，只是换一段新会话。
                删除入口在历史列表的每一行上，避免"点了清空，历史里还在"的误解。
              */}
              {messages.length > 0 && (
                <button
                  onClick={handleNewSession}
                  className={styles.clearButton}
                  title={isStreaming ? '中止当前回答并开始新对话' : '开始一段新对话'}
                >
                  ＋ 新对话
                </button>
              )}
            </div>
          )}
      </div>

      {/* ---- Error banner ---- */}
      {/* useChat resets the error state on the next send, so onDismiss is a no-op. */}
      {error && (
        <ErrorBanner
          message={error}
          onRetry={retryLast}
          onDismiss={() => {/* useChat handles error clearing on next send */}}
        />
      )}

      {/* ---- Message list ---- */}
      <MessageList
        messages={messages}
        onSuggestionClick={sendMessage}
        // 浏览器不支持语音合成时不给按钮，避免点下去毫无反应
        onReadAloud={ttsSupported ? handleReadAloud : undefined}
        speakingMessageId={speakingMessageId}
        selectedReferencesId={selectedReferencesId}
        onShowReferences={handleShowReferences}
      />

      {/* ---- Input area (fixed at bottom) ---- */}
      <ChatInput
        onSend={sendMessage}
        disabled={isStreaming}
        isStreaming={isStreaming}
        onStop={stopGenerating}
      />
      </div>

      <ReferencePanel
        references={selectedMessage?.references ?? []}
        // 只关心**选中的那一轮**是否还在生成：正在检索时引用为空是正常中间态，
        // 不能拿整段对话的 isStreaming 当判断依据。
        isStreaming={Boolean(selectedMessage?.isStreaming)}
        hasAnswer={Boolean(selectedMessage)}
        subtitle={selectedTime}
      />

      {/*
        历史会话抽屉。和聊天区放在同一层，antd 会 portal 到 body，
        不受聊天区布局影响。宽度 300px 足够放下标题 + 条数/时间。
      */}
      <Drawer
        title="历史会话"
        placement="left"
        width={300}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        <SessionList
          sessions={sessions}
          activeSessionId={sessionId}
          loading={loadingSessions}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onNewSession={handleNewSession}
        />
      </Drawer>
    </div>
  );
}
