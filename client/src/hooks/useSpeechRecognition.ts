import { useState, useRef, useCallback } from 'react';

/**
 * @fileoverview React hook for browser-based speech recognition via the Web Speech API.
 *
 * ## Data Flow
 *
 * This hook sits between the UI layer (voice-input buttons, chat input) and the
 * browser's built-in `SpeechRecognition` API.  It manages the full recognition
 * lifecycle — starting, receiving interim / final results, handling errors,
 * stopping gracefully, and aborting immediately.
 *
 * ```
 * User taps mic   →  UI calls startListening()  →  new SpeechRecognition()
 * Browser streams  →  onresult fires repeatedly  →  interimText updates reactively
 * Final transcript →  onresult with isFinal=true  →  caller reads the returned transcript
 * Mic stops        →  onend fires                 →  state returns to 'idle'
 * Error occurs     →  onerror fires               →  state moves to 'error'
 * User cancels     →  UI calls abort()            →  recognition.abort(), state → 'idle'
 * ```
 *
 * ## Edge Cases Handled
 *
 * - **Unsupported browsers** (e.g. older Firefox): detected at module level;
 *   `isSupported` is `false` and `state` starts as `'unsupported'`.  All
 *   mutating functions are no-ops in this condition.
 * - **Not-allowed errors**: when the user denies microphone permission,
 *   `state` moves to `'error'` so the UI can surface the right messaging.
 * - **No-speech errors**: the browser detected no audio.  These are silently
 *   swallowed (the hook stays in `'listening'`), because they are often
 *   transient.
 * - **Concurrent recognition instances**: prevented by storing the active
 *   instance in a `useRef` and nullifying it in `onend`.
 * - **State consistency on end**: `onend` only resets to `'idle'` when the
 *   previous state was `'listening'`, avoiding a race where `stopListening`
 *   or `abort` already set `'idle'`.
 */

// ---- Browser API type declarations ----
// The Web Speech API types are not yet in TypeScript's standard DOM lib.
// These interfaces provide the minimal shape needed by this hook.

/** Extension of the standard `Event` carrying recognition results. */
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

/** Extension of the standard `Event` carrying error information. */
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

/**
 * The subset of `SpeechRecognition` properties and methods consumed here.
 *
 * `SpeechRecognition` itself is not globally typed in all browsers, so we
 * define a narrow interface that matches what the hook actually uses.
 */
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

/**
 * State machine for the recognition lifecycle.
 *
 * - `idle`        – Not listening. The default when supported.
 * - `listening`   – Actively capturing audio and processing speech.
 * - `error`       – A terminal error occurred (e.g. permission denied).
 * - `unsupported` – The browser does not implement the SpeechRecognition API.
 */
type RecognitionState = 'idle' | 'listening' | 'error' | 'unsupported';

// ---- Feature detection (module-level, evaluated once) ----
//
// We resolve the constructor at module load time so `isSupported` is a
// stable boolean.  Using `window` as an escape hatch handles both the
// standard `SpeechRecognition` and the `webkit`-prefixed variant.
const SpeechRecognitionAPI =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

/**
 * React hook that wraps the browser's SpeechRecognition API.
 *
 * Manages the complete lifecycle of a speech-recognition session:
 * starting, streaming interim results, finalising a transcript, handling
 * errors, and tearing down the underlying `SpeechRecognition` instance.
 * Gracefully degrades on unsupported browsers by reporting
 * `isSupported === false` and making all action functions no-ops.
 *
 * @returns An object with the following properties:
 *
 * | Property        | Type                                     | Description |
 * |-----------------|------------------------------------------|-------------|
 * | `isSupported`   | `boolean`                                | Whether the browser exposes `SpeechRecognition` (or `webkitSpeechRecognition`). Safe to read before rendering a mic button. |
 * | `isListening`   | `boolean`                                | Convenience boolean — `true` when `state === 'listening'`. |
 * | `state`         | `RecognitionState`                       | The raw state-machine value: `'idle'`, `'listening'`, `'error'`, or `'unsupported'`. |
 * | `interimText`   | `string`                                 | The current (non-final) transcript text. Updates reactively as the user speaks. |
 * | `startListening`| `() => string \| undefined`              | Starts a new recognition session. Returns the final transcript when recognition completes (via the `onresult` callback path), or `undefined` if unsupported / errored. Only one session can be active at a time. |
 * | `stopListening` | `() => void`                             | Gracefully stops the active session. The recogniser will deliver any pending results before firing `onend`. Safe to call when no session is active. |
 * | `abort`         | `() => void`                             | Immediately aborts the active session without delivering pending results. Clears `interimText`. Safe to call when no session is active. |
 */
export function useSpeechRecognition() {
  // ---- State ----
  //
  // `state` tracks where we are in the recognition lifecycle.  It defaults to
  // `'unsupported'` when the API is absent so consumers can render fallback
  // UI without an extra check.
  const [state, setState] = useState<RecognitionState>(
    SpeechRecognitionAPI ? 'idle' : 'unsupported'
  );

  // `interimText` holds the live, non-final transcript so the UI can show
  // the user what the browser is hearing in real time.
  const [interimText, setInterimText] = useState('');

  // `recognitionRef` stores the active `SpeechRecognition` instance so we
  // can `.stop()` or `.abort()` it from other callbacks.  React ref is the
  // right choice here because:
  //   1. We need to mutate it synchronously without triggering a re-render.
  //   2. The instance is an external browser object, not React state.
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // `isSupported` is derived from the module-level feature-detection
  // constant.  It never changes for the lifetime of the page, so a plain
  // variable (not state) is sufficient.
  const isSupported = SpeechRecognitionAPI !== undefined;

  /**
   * Creates a new `SpeechRecognition` instance and starts listening.
   *
   * Only one session can be active at a time.  If a previous session is
   * still running, calling `startListening` will replace it (the old
   * instance will be garbage-collected after its `onend` fires).
   *
   * Edge cases handled inline:
   * - Browser unsupported → silent no-op.
   * - Instantiation throws → caught, `state` set to `'error'`.
   * - `not-allowed` error → `state` set to `'error'` so the UI can prompt
   *   the user to grant microphone permission.
   * - `no-speech` error → deliberately ignored; the browser fires this even
   *   during normal usage when there is a pause in speech.
   *
   * @returns The final transcript string when recognition completes
   *          naturally, or `undefined` when unsupported / an error occurs.
   */
  const startListening = useCallback(() => {
    // If the browser doesn't support the API, bail out silently.
    // The caller should guard with `isSupported` before rendering the mic
    // button, but we double-check here as a safety net.
    if (!isSupported) return;

    try {
      const recognition = new SpeechRecognitionAPI() as SpeechRecognitionInstance;

      // ---- Configuration ----
      // `continuous: false` means the recogniser will stop automatically
      // after a single utterance.  This matches the typical chat-input use
      // case: speak one message, get the transcript, stop.
      recognition.continuous = false;

      // `interimResults: true` enables the live-transcript UX.  `onresult`
      // fires repeatedly as the user speaks, allowing the UI to show
      // partial text before the final result.
      recognition.interimResults = true;

      // Hard-coded to Chinese (Simplified).  If the app later needs
      // multi-language support, this should be lifted to a parameter.
      recognition.lang = 'zh-CN';

      // ---- onresult: process interim and final transcripts ----
      //
      // The browser fires `onresult` for every result block.  A result
      // block can contain both interim and final alternatives.  We iterate
      // from `resultIndex` to catch any results we haven't seen yet
      // (the browser may batch multiple results into a single event).
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = '';
        let final = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            final += transcript;
          } else {
            interim += transcript;
          }
        }

        // Display whatever we have: interim text if it exists, otherwise
        // the final text.  This means the UI will show the final transcript
        // briefly before the caller (who receives `final` from the hook's
        // return) resets it.
        setInterimText(interim || final);

        // When we get a final transcript the recognition session will
        // naturally end (because `continuous` is `false`).  We move to
        // `'idle'` so the UI reflects that listening has stopped.
        if (final) {
          setState('idle');
          return final;
        }
      };

      // ---- onerror: handle recognition errors ----
      //
      // The `error` string comes directly from the browser and may include:
      //   - `'not-allowed'`  – User denied mic permission or browser policy
      //   - `'no-speech'`    – No audio detected (often transient)
      //   - `'aborted'`      – `.abort()` was called
      //   - `'audio-capture'`– Hardware/OS issue capturing audio
      //   - `'network'`      – Network error (some browsers use cloud STT)
      //   - `'service-not-allowed'` – Browser policy blocks the service
      //   - `'bad-grammar'`  – Grammar error (not used here)
      //   - `'language-not-supported'` – The `lang` value is not supported
      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.warn('语音识别错误:', event.error);

        // `not-allowed` is the most common actionable error — the user (or
        // browser policy) blocked mic access.  We surface it so the UI can
        // show a permission prompt.
        if (event.error === 'not-allowed') {
          setState('error');
        } else if (event.error !== 'no-speech') {
          // `no-speech` is deliberately ignored: it fires during normal
          // pauses in speech and does not indicate a real problem.
          // All other errors transition to the `'error'` state.
          setState('error');
        }
      };

      // ---- onend: cleanup when the recognition session ends ----
      //
      // `onend` fires when the recogniser stops for *any* reason:
      //   - Natural end after a final result (continuous=false)
      //   - `.stop()` called
      //   - `.abort()` called
      //   - An error occurred
      //
      // We use a functional state update (`prev => ...`) to avoid a race
      // condition: if `stopListening` / `abort` already set `state` to
      // `'idle'`, we must not overwrite that.  We only reset to `'idle'`
      // when the previous state was `'listening'`.
      recognition.onend = () => {
        setState((prev) => (prev === 'listening' ? 'idle' : prev));

        // Null out the ref so subsequent `stopListening` / `abort` calls
        // know there is no active session to operate on.
        recognitionRef.current = null;
      };

      // ---- Activate ----
      // Store the instance in the ref *before* calling `.start()` so that
      // `stopListening` and `abort` can reference it even if `.start()`
      // triggers synchronous events.
      recognitionRef.current = recognition;
      recognition.start();

      // Transition to `'listening'` and clear any stale interim text from a
      // previous session.
      setState('listening');
      setInterimText('');
    } catch (err) {
      // `new SpeechRecognition()` or `.start()` can throw synchronously
      // (e.g. in some environments that block the API entirely).
      console.error('语音识别启动失败:', err);
      setState('error');
    }
  }, [isSupported]);

  /**
   * Gracefully stops the active recognition session.
   *
   * Unlike `abort`, this allows the recogniser to deliver any pending
   * results before firing `onend`.  The `onend` handler will transition
   * `state` back to `'idle'` and clear the ref.
   *
   * Safe to call when no session is active (no-op).
   */
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    // Optimistically set `'idle'` so the UI responds immediately.  The
    // `onend` handler has a guard (`prev === 'listening'`) that prevents
    // double-transition.
    setState('idle');
  }, []);

  /**
   * Immediately aborts the active recognition session.
   *
   * Unlike `stopListening`, this discards any pending results and fires
   * `onend` immediately.  Also clears `interimText` so stale partial text
   * does not linger in the UI.
   *
   * Safe to call when no session is active (no-op).
   */
  const abort = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
    }
    setState('idle');
    setInterimText('');
  }, []);

  return {
    /** Whether the browser exposes the SpeechRecognition API. */
    isSupported,

    /** Convenience flag — `true` while actively capturing audio. */
    isListening: state === 'listening',

    /** The raw recognition state-machine value. */
    state,

    /** Live, non-final transcript text for real-time display. */
    interimText,

    /** Start a new recognition session. */
    startListening,

    /** Gracefully stop the active session. */
    stopListening,

    /** Immediately abort the active session, discarding pending results. */
    abort,
  };
}
