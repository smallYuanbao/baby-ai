import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { consumeSSEStream } from '../services/sse';
import type { SSEEvent } from '../types/chat';

/**
 * @fileoverview Interactive Play Hook — React custom hook for the Baby AI play feature.
 *
 * This hook is the **stateful orchestration layer** between the UI components and the
 * play API backend. It manages shared loading/error state and exposes action functions
 * for three interactive play modes:
 *
 *  1. **Story Generation** — AI-generated children's stories streamed token-by-token
 *     via Server-Sent Events (SSE). The caller receives tokens through an `onToken`
 *     callback for progressive rendering (typewriter effect).
 *
 *  2. **Riddle Game** — Fetch age-appropriate riddles and submit guesses. The
 *     get-guess cycle is split into two calls so the UI can present the riddle first
 *     and wait for user input before revealing the result.
 *
 *  3. **Baby-Talk Interpretation** — Parents describe their baby's sounds or gestures
 *     and the AI returns a human-readable interpretation.
 *
 * ## Data Flow
 *
 * ```
 * UI Component
 *     │
 *     ├─ usePlay() ──── api.play.requestStory() ──► POST /play/story
 *     │    │                                         (SSE stream)
 *     │    └─ consumeSSEStream(response) ──► AsyncGenerator<SSEEvent>
 *     │              │
 *     │              └─ onToken(token) ──► component state (progressive render)
 *     │
 *     ├─ usePlay() ──── api.play.getRiddle() ─────► POST /play/riddle
 *     │    │                                         (JSON response)
 *     │    └─ returns RiddleState ──► component displays riddle text
 *     │
 *     ├─ usePlay() ──── api.play.guessRiddle() ───► POST /play/riddle/guess
 *     │    │                                         (JSON response)
 *     │    └─ returns RiddleResult ──► component shows correct/incorrect
 *     │
 *     └─ usePlay() ──── api.play.interpretBabyTalk() ──► POST /play/baby-talk
 *                          (JSON response)
 * ```
 *
 * ## State Management
 *
 * - `loading` — true while any play operation is in flight; used by the UI for
 *   spinners and button-disabling. Shared across all operations because concurrent
 *   play actions are not expected in normal usage.
 * - `error` — the most recent error message (or null). **Never auto-cleared** by
 *   this hook; callers must call `setError(null)` when they want to dismiss an
 *   error banner.
 *
 * ## Edge Cases & Design Decisions
 *
 * - **Non-blocking error on guess**: `guessRiddle` returns `null` on failure but
 *   does NOT set `loading = true` because ① guessing is a quick JSON round-trip,
 *   not a stream, and ② setting loading would flash the spinner on every wrong
 *   guess, degrading UX. The error is still pushed to `error` state.
 * - **Stream functions return boolean**: `generateStory` returns `true` on success,
 *   `false` on failure so the caller can distinguish a clean stream end from an
 *   error without inspecting the error string.
 * - **Error content preservation**: The `catch` blocks normalise all errors to
 *   strings with Chinese fallback messages for the Baby AI target audience.
 * - **Cleanup**: SSE consumption via `for await...of` naturally stops when the
 *   stream ends or when the AbortController (set up by the caller on the fetch
 *   response) aborts. No additional teardown is needed in this hook.
 */

/** Shape of a riddle returned by the server, ready for display. */
export interface RiddleState {
  /** Server-assigned unique identifier for this riddle session. */
  riddleId: string;
  /** The riddle text to present to the child. */
  riddle: string;
  /** Category label for grouping/display (e.g. "animals", "food"). */
  category: string;
  /** Difficulty tier (e.g. "easy", "medium", "hard"). */
  difficulty: string;
}

/** Outcome of a riddle guess or hint request. */
export interface RiddleResult {
  /** Whether the submitted guess was correct (false when requesting a hint). */
  correct: boolean;
  /** The correct answer, revealed after a wrong guess or hint request. */
  answer?: string;
  /** A hint to nudge the child toward the answer (only present on hint requests). */
  hint?: string;
  /** Encouraging message for the child, regardless of correctness. */
  encouragement?: string;
}

/**
 * React hook that provides all interactive play capabilities for the Baby AI app.
 *
 * Manages shared loading/error state and exposes memoised action functions for
 * story generation, riddle gameplay, and baby-talk interpretation. All actions
 * are stable across re-renders (wrapped in `useCallback` with an empty deps
 * array) because they only depend on the `setState` dispatchers, which are
 * already stable per React's guarantee.
 *
 * @returns An object containing:
 *   - `loading` — true when a story or non-guess play operation is in progress
 *   - `error`   — the most recent error string, or null if no error
 *   - `setError` — direct setter so callers can dismiss error banners
 *   - `generateStory` — initiates SSE story generation; returns `true` on success
 *   - `getRiddle` — fetches a riddle for the given age/difficulty
 *   - `guessRiddle` — submits a guess or requests a hint for an active riddle
 *   - `interpretBabyTalk` — interprets a parent's description of baby sounds/gestures
 */
export function usePlay() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Generate an AI-powered children's story and stream it token-by-token via SSE.
   *
   * Sends a POST request to `/play/story` with the child's age, optional interest
   * theme, and optional story type. The server responds with `text/event-stream`;
   * this function consumes that stream through {@link consumeSSEStream}, invoking
   * `onToken` for each received text token so the caller can render progressively
   * (typewriter effect).
   *
   * ## SSE Event Contract
   * - `event: "token"` → `data: { text: string }` — a chunk of story text
   * - `event: "error"` → `data: { message: string }` — server-side generation error
   *
   * ## State Side Effects
   * - Sets `loading = true` before the fetch (blocks the UI during generation)
   * - Clears any previous error via `setError(null)`
   * - Sets `loading = false` in `finally` — always runs, even on error
   *
   * @param childAge  - Age of the child (used to tailor story complexity/vocabulary)
   * @param onToken   - Callback invoked for each received text token; called with
   *                    the raw token string for progressive UI rendering
   * @param interest  - Optional theme filter (e.g. "animals", "space")
   * @param storyType - Optional story format (e.g. "bedtime", "adventure")
   * @returns `true` if the story stream completed successfully; `false` if any
   *          error occurred (fetch failure, SSE error event, or stream abort).
   *          On failure, the `error` state is also set.
   */
  const generateStory = useCallback(async (
    childAge: number,
    onToken: (text: string) => void,
    interest?: string,
    storyType?: string,
  ): Promise<boolean> => {
    try {
      setLoading(true);
      // Clear any stale error from a previous operation so the UI doesn't
      // show an old error banner while the new story is loading.
      setError(null);

      const response = await api.play.requestStory(childAge, interest, storyType);
      // Double-check response.ok even though consumeSSEStream also checks —
      // this gives us a cleaner error message before entering the stream loop.
      if (!response.ok) throw new Error('请求失败');

      for await (const event of consumeSSEStream(response)) {
        if (event.event === 'token') {
          // Defensive access: cast data to expected shape and fall back to ''
          // if the text field is missing (malformed server event).
          onToken((event.data as { text: string })?.text || '');
        } else if (event.event === 'error') {
          // Server sent an explicit error event — surface it to the user.
          throw new Error((event.data as any)?.message || '生成失败');
        }
        // Ignore other event types (e.g. "done") — the stream end is
        // signalled by the generator finishing, not a specific event.
      }
      return true;
    } catch (err: any) {
      setError(err.message || '故事生成失败');
      return false;
    } finally {
      // Always reset loading, even if the stream aborted mid-flight.
      setLoading(false);
    }
  }, []);

  /**
   * Fetch an age-appropriate riddle from the server.
   *
   * Sends a POST request to `/play/riddle` with the child's age and an optional
   * difficulty tier. The server returns a {@link RiddleState} containing the
   * riddle text, category, and a unique `riddleId` used later to submit a guess
   * via {@link guessRiddle}.
   *
   * ## State Side Effects
   * - Sets `loading = true` before the fetch
   * - Clears any previous error via `setError(null)`
   * - Sets `loading = false` in `finally`
   *
   * @param childAge   - Age of the child (used to select age-appropriate content)
   * @param difficulty - Optional difficulty tier (e.g. "easy", "medium", "hard")
   * @returns A {@link RiddleState} on success, or `null` on failure (with the
   *          error message stored in the `error` state).
   */
  const getRiddle = useCallback(async (childAge: number, difficulty?: string): Promise<RiddleState | null> => {
    try {
      setLoading(true);
      // Clear any stale error from a previous operation.
      setError(null);
      const result = await api.play.getRiddle(childAge, difficulty);
      return result;
    } catch (err: any) {
      setError(err.message || '获取谜语失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Submit a guess for an active riddle or request a hint.
   *
   * Sends a POST request to `/play/riddle/guess`. The server checks the guess
   * against the correct answer or generates a hint, then returns a
   * {@link RiddleResult} with correctness, the answer (if wrong), and an
   * encouraging message.
   *
   * ## Design Note: Why This Does NOT Set `loading`
   *
   * Unlike the other actions, `guessRiddle` does **not** set `loading = true`.
   * Guessing is a quick JSON round-trip (no SSE streaming), and toggling loading
   * on every guess would flash the spinner repeatedly during gameplay, degrading
   * the user experience. Errors are still surfaced through the `error` state.
   *
   * @param riddleId - The server-assigned ID from {@link getRiddle}
   * @param guess    - The child's guess text (optional — omit when requesting a hint)
   * @param hint     - Pass `true` to request a hint instead of checking a guess
   * @returns A {@link RiddleResult} on success, or `null` on failure (with the
   *          error message stored in the `error` state).
   */
  const guessRiddle = useCallback(async (
    riddleId: string,
    guess?: string,
    hint?: boolean,
  ): Promise<RiddleResult | null> => {
    try {
      return await api.play.guessRiddle(riddleId, guess, hint);
    } catch (err: any) {
      setError(err.message || '提交失败');
      return null;
    }
  }, []);

  /**
   * Interpret a parent's description of their baby's sounds or gestures using AI.
   *
   * Sends a POST request to `/play/baby-talk` with the free-text description and
   * optional baby age. The server returns an AI-generated interpretation string
   * suggesting what the baby might be trying to communicate.
   *
   * ## State Side Effects
   * - Sets `loading = true` before the fetch
   * - Clears any previous error via `setError(null)`
   * - Sets `loading = false` in `finally`
   *
   * @param description - Free-text description of the baby's sounds, gestures,
   *                      or behaviour (e.g. "she keeps pointing at the fridge
   *                      and making 'mmm' sounds")
   * @param babyAge     - Optional age of the baby in months (helps the AI
   *                      calibrate developmental-stage expectations)
   * @returns The AI interpretation string on success, or `null` on failure
   *          (with the error message stored in the `error` state). An empty
   *          string result is also returned as-is — the caller should handle
   *          it as "no interpretation available" rather than an error.
   */
  const interpretBabyTalk = useCallback(async (description: string, babyAge?: number): Promise<string | null> => {
    try {
      setLoading(true);
      // Clear any stale error from a previous operation.
      setError(null);
      const result = await api.play.interpretBabyTalk(description, babyAge);
      // Use the interpretation field; fall back to '' if the server returned
      // a success response without an interpretation (valid edge case).
      return result.interpretation || '';
    } catch (err: any) {
      setError(err.message || '翻译失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    setError,
    generateStory,
    getRiddle,
    guessRiddle,
    interpretBabyTalk,
  };
}
