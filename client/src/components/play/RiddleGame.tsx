/**
 * RiddleGame — interactive riddle-guessing screen for children.
 *
 * The user selects a childʼs age and a difficulty level, then fetches a riddle
 * from the backend.  They can submit guesses, request hints, and earn points
 * for correct answers.  The component owns its own local state (riddle, guess,
 * result, hint, score, loading) and delegates API calls to the {@link usePlay}
 * hook.
 *
 * @module RiddleGame
 */

import { useState } from 'react';
import { usePlay, type RiddleState } from '../../hooks/usePlay';
import { Button } from '../shared/Button';
import styles from './RiddleGame.module.less';

/**
 * Props accepted by the {@link RiddleGame} component.
 */
interface RiddleGameProps {
  /** Callback that navigates the user back to the previous screen. */
  onBack: () => void;
}

/**
 * RiddleGame component.
 *
 * Renders a two-phase screen:
 *
 * 1. **Setup** — age / difficulty picker + "fetch riddle" button.
 * 2. **Game**   — riddle card, hint area, result feedback, guess input,
 *    and action buttons (submit guess, show hint, fetch a new riddle).
 *
 * @param props - {@link RiddleGameProps}
 * @returns The rendered component tree.
 */
export function RiddleGame({ onBack }: RiddleGameProps) {
  const { getRiddle, guessRiddle } = usePlay();

  // ---- UI configuration ------------------------------------------------
  const [childAge, setChildAge] = useState(5);
  const [difficulty, setDifficulty] = useState<string>('easy');

  // ---- Game state ------------------------------------------------------
  const [riddle, setRiddle] = useState<RiddleState | null>(null);
  const [guess, setGuess] = useState('');
  const [result, setResult] = useState<string>('');
  const [hint, setHint] = useState<string>('');
  const [score, setScore] = useState(0);
  const [loading, setLoading] = useState(false);

  /**
   * Fetch a new riddle from the server based on the selected age and
   * difficulty.  Resets guess, result, and hint before the request.
   */
  const handleGetRiddle = async () => {
    setLoading(true);
    setResult('');
    setHint('');
    setGuess('');
    const r = await getRiddle(childAge, difficulty);
    if (r) setRiddle(r);
    setLoading(false);
  };

  /**
   * Submit the userʼs current guess to the server.
   *
   * On a correct answer the score increments by 10 and a celebration
   * message is shown; otherwise an encouraging hint is displayed.
   */
  const handleGuess = async () => {
    if (!riddle || !guess.trim()) return;
    const res = await guessRiddle(riddle.riddleId, guess.trim());
    if (!res) return;

    if (res.correct) {
      setResult(`🎉 ${res.encouragement} 答案就是：${res.answer}`);
      setScore((s) => s + 10);
    } else {
      setResult(`❌ ${res.encouragement}`);
    }
  };

  /**
   * Request a hint for the current riddle from the server.
   *
   * Calls {@link guessRiddle} with `undefined` as the guess and `true` for
   * the hint flag so the backend returns only hint text.
   */
  const handleHint = async () => {
    if (!riddle) return;
    const res = await guessRiddle(riddle.riddleId, undefined, true);
    if (res?.hint) setHint(res.hint);
  };

  return (
    <div className={styles.wrapper}>
      {/* ---- Top bar: back button, title, score ---- */}
      <div className={styles.topBar}>
        <button onClick={onBack} className={styles.backButton}>← 返回</button>
        <h3 className={styles.screenTitle}>🧩 猜谜语</h3>
        <span className={styles.score}>{score}分</span>
      </div>

      <div className={styles.content}>
        {!riddle ? (
          /* ---- Setup phase: age & difficulty selection ---- */
          <div className={styles.setupSection}>
            <div>
              <label className={styles.label}>宝宝年龄</label>
              <div className={styles.optionGroup}>
                {[3, 4, 5, 6, 7, 8].map((age) => (
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
            <div>
              <label className={styles.label}>难度</label>
              <div className={styles.optionGroup}>
                {[
                  { key: 'easy', label: '⭐ 简单' },
                  { key: 'medium', label: '⭐⭐ 中等' },
                  { key: 'hard', label: '⭐⭐⭐ 困难' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setDifficulty(key)}
                    className={`${styles.optionButton} ${difficulty === key ? styles.activeDifficulty : styles.inactiveDifficulty}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Button onClick={handleGetRiddle} disabled={loading} className={styles.fullWidth}>
              {loading ? '出题中...' : '🎲 来一题'}
            </Button>
          </div>
        ) : (
          /* ---- Game phase: riddle display, hints, results, input ---- */
          <div className={`${styles.gameSection} animate-fade-in`}>
            {/* Riddle card showing category, difficulty stars, and riddle text */}
            <div className={styles.riddleCard}>
              <span className={styles.riddleCategory}>{riddle.category} · {riddle.difficulty === 'easy' ? '⭐' : riddle.difficulty === 'medium' ? '⭐⭐' : '⭐⭐⭐'}</span>
              <p className={styles.riddleText}>{riddle.riddle}</p>
            </div>

            {/* Conditional hint display */}
            {hint && (
              <div className={`${styles.hintBox} animate-fade-in`}>
                <span className={styles.hintText}>💡 {hint}</span>
              </div>
            )}

            {/* Conditional result feedback — green for correct, grey for incorrect */}
            {result && (
              <div className={`${styles.resultBox} animate-fade-in ${result.startsWith('🎉') ? styles.success : styles.failure}`}>
                <span className={styles.resultText}>{result}</span>
              </div>
            )}

            {/* Guess input row */}
            <div className={styles.guessRow}>
              <input
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGuess()}
                placeholder="输入你的答案..."
                className={styles.guessInput}
              />
              <Button onClick={handleGuess} disabled={!guess.trim()}>猜！</Button>
            </div>

            {/* Secondary actions: hint and new riddle */}
            <div className={styles.actionRow}>
              <Button variant="ghost" onClick={handleHint} className={styles.flex1}>💡 提示</Button>
              <Button variant="ghost" onClick={handleGetRiddle} className={styles.flex1}>🎲 换一题</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
