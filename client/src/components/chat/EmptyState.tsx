/**
 * @file EmptyState.tsx
 * @description The empty-state view shown when the chat has no messages yet.
 *
 * Displays a branded mascot illustration, a friendly greeting heading,
 * a subtitle describing the assistant's purpose, and a grid of suggested
 * question chips that users can tap to quickly start a conversation.
 *
 * @module components/chat/EmptyState
 */

import styles from './EmptyState.module.less';

/**
 * Props accepted by the {@link EmptyState} component.
 */
interface EmptyStateProps {
  /** Callback fired when the user clicks a suggestion chip. Receives the suggestion text. */
  onSuggestionClick: (text: string) => void;
}

/**
 * Curated list of suggested starter questions.
 * Each entry pairs an emoji icon with a Chinese-language parenting question.
 * The array is defined outside the component so it is never recreated on re-render.
 */
const SUGGESTIONS = [
  { icon: '🌙', text: '宝宝晚上哭闹怎么办？' },
  { icon: '🍼', text: '新生儿喂养频率建议' },
  { icon: '💉', text: '宝宝疫苗接种时间表' },
  { icon: '📈', text: '0-6个月发育里程碑' },
  { icon: '🤒', text: '宝宝发烧怎么处理？' },
  { icon: '😴', text: '如何培养宝宝规律作息？' },
];

/**
 * Renders the empty-state placeholder shown when a chat session has
 * no messages.  Includes an animated mascot logo, a welcome message,
 * and tappable suggestion chips that trigger {@link EmptyStateProps.onSuggestionClick}.
 *
 * @param props - See {@link EmptyStateProps}.
 * @returns A React element representing the empty-chat view.
 */
export function EmptyState({ onSuggestionClick }: EmptyStateProps) {
  return (
    <div className={`${styles.wrapper} animate-fade-in`}>
      {/* Mascot logo: hand-drawn bear illustration built with SVG primitives */}
      <div className={styles.logoContainer}>
        <svg viewBox="0 0 100 100" className={styles.logoIcon}>
          {/* Head */}
          <circle cx="50" cy="55" r="28" fill="#fff7ed" />
          {/* Left ear */}
          <circle cx="28" cy="32" r="12" fill="#fff7ed" />
          {/* Right ear */}
          <circle cx="72" cy="32" r="12" fill="#fff7ed" />
          {/* Left inner ear */}
          <circle cx="28" cy="32" r="6" fill="#fdba74" />
          {/* Right inner ear */}
          <circle cx="72" cy="32" r="6" fill="#fdba74" />
          {/* Left eye */}
          <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
          {/* Right eye */}
          <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
          {/* Left eye highlight */}
          <circle cx="41" cy="51" r="1.5" fill="white" />
          {/* Right eye highlight */}
          <circle cx="61" cy="51" r="1.5" fill="white" />
          {/* Nose */}
          <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
          {/* Mouth (smile arc) */}
          <path d="M40 70 Q50 78 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>

      <h2 className={styles.heading}>你好，我是小熊育儿助手 🐻</h2>
      <p className={styles.subtitle}>
        用科学知识和温暖陪伴，帮你解答育儿路上的疑惑
      </p>

      {/* Suggestion chips: pre-built queries the user can tap to start a conversation */}
      <div className={styles.suggestionsWrapper}>
        <p className={styles.suggestionsLabel}>你可以这样问我：</p>
        <div className={styles.suggestionsGrid}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.text}
              onClick={() => onSuggestionClick(s.text)}
              className={`${styles.suggestionButton} group`}
            >
              <span className={styles.suggestionIcon}>{s.icon}</span>
              <p className={styles.suggestionText}>
                {s.text}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
