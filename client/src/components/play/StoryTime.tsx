/**
 * @file StoryTime.tsx
 * @description AI-powered story generation screen for children.
 *
 * Allows parents/caregivers to configure a story by selecting the child's age,
 * story type (bedtime, adventure, educational), and an optional interest topic.
 * The story text is streamed in real-time via a callback and rendered as Markdown.
 *
 * States:
 *  - Setup:     user fills in preferences (age, type, interest)
 *  - Generating: streaming story content in real-time
 *  - Done:       completed story displayed with options to regenerate or change topic
 */

import { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { usePlay } from '../../hooks/usePlay';
import { Button } from '../shared/Button';
import styles from './StoryTime.module.less';

/** Props for the StoryTime screen. */
interface StoryTimeProps {
  /** Callback fired when the user taps the back button. */
  onBack: () => void;
}

/**
 * StoryTime component — AI story generation for kids.
 *
 * Workflow:
 *  1. User configures child age, story type, and optional interest.
 *  2. On generate, `generateStory` is called with a streaming callback
 *     that accumulates chunks into `contentRef.current` and updates state.
 *  3. When the stream finishes, `done` is set to true, revealing action buttons.
 *
 * @param props.onBack - Navigate back to the previous screen.
 */
export function StoryTime({ onBack }: StoryTimeProps) {
  const { generateStory } = usePlay();

  // ---- Configuration state ----
  /** Selected child age (default 3). */
  const [childAge, setChildAge] = useState(3);
  /** Free-text interest field (e.g. "dinosaurs", "princesses"). */
  const [interest, setInterest] = useState('');
  /** Selected story genre key. */
  const [storyType, setStoryType] = useState<string>('bedtime');

  // ---- Generation state ----
  /** Accumulated story text displayed in the Markdown viewer. */
  const [content, setContent] = useState('');
  /** Whether a story generation is in progress. */
  const [generating, setGenerating] = useState(false);
  /** Whether generation has completed and a story is ready to view. */
  const [done, setDone] = useState(false);

  /**
   * Mutable ref holding the full story text during streaming.
   * Used instead of reading `content` state directly to avoid stale closures
   * inside the streaming callback.
   */
  const contentRef = useRef('');

  /**
   * Kick off story generation with the current configuration.
   * Resets display state, then calls `generateStory` which invokes the
   * streaming callback for each text chunk.
   */
  const handleGenerate = async () => {
    setGenerating(true);
    setContent('');
    setDone(false);
    contentRef.current = '';

    // `generateStory` streams tokens via the callback; returns true on success.
    const success = await generateStory(
      childAge,
      (text) => {
        contentRef.current += text;
        setContent(contentRef.current);
      },
      interest || undefined, // treat empty string as "no preference"
      storyType,
    );

    if (success) setDone(true);
    setGenerating(false);
  };

  return (
    <div className={styles.wrapper}>
      {/* ---- Top navigation bar ---- */}
      <div className={styles.topBar}>
        <button onClick={onBack} className={styles.backButton}>← 返回</button>
        <h3 className={styles.screenTitle}>📖 讲故事</h3>
        <div className={styles.spacer} />
      </div>

      {/* ---- Setup panel (hidden while generating or after completion) ---- */}
      {!done && !generating && (
        <div className={styles.setupPanel}>
          {/* Age selector */}
          <div>
            <label className={styles.label}>宝宝年龄</label>
            <div className={styles.optionGroup}>
              {[1, 2, 3, 4, 5, 6, 8].map((age) => (
                <button
                  key={age}
                  onClick={() => setChildAge(age)}
                  className={`${styles.optionButton} ${childAge === age ? styles.activeAge : styles.inactiveOption}`}
                >
                  {age}岁
                </button>
              ))}
            </div>
          </div>

          {/* Story type selector */}
          <div>
            <label className={styles.label}>故事类型</label>
            <div className={styles.optionGroup}>
              {[
                { key: 'bedtime', label: '🌙 睡前', icon: '🌙' },
                { key: 'adventure', label: '🗺 冒险', icon: '🗺' },
                { key: 'educational', label: '📚 教育', icon: '📚' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setStoryType(key)}
                  className={`${styles.optionButton} ${storyType === key ? styles.activeType : styles.inactiveType}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional interest input */}
          <div>
            <label className={styles.label}>喜欢什么？（选填）</label>
            <input
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              placeholder="如：恐龙、公主、太空..."
              className={styles.input}
            />
          </div>

          {/* Generate trigger */}
          <Button onClick={handleGenerate} className={styles.fullWidth}>
            ✨ 生成故事
          </Button>
        </div>
      )}

      {/* ---- Story output area (visible during generation and after completion) ---- */}
      {(generating || done) && (
        <div className={styles.storyContent}>
          {/* Scrollable story card */}
          <div className={styles.storyBox}>
            <div className={`markdown-content ${styles.markdownBody}`}>
              <ReactMarkdown>{content || '正在构思故事...'}</ReactMarkdown>
            </div>
          </div>

          {/* Post-generation actions */}
          {done && (
            <div className={styles.storyActions}>
              <Button onClick={handleGenerate} className={styles.fullWidth} variant="secondary">
                🔄 再讲一个
              </Button>
              <Button onClick={() => { setDone(false); setContent(''); }} className={styles.fullWidth} variant="ghost">
                换一个主题
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
