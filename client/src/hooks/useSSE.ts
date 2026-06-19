/**
 * @fileoverview SSE (Server-Sent Events) connection hook for the Baby AI client.
 *
 * ## Data Flow Position
 * This hook sits between the UI components (chat panels, status indicators) and the
 * SSE transport layer (`../services/sse`). It:
 *   1. Accepts a `fetchFn` factory and event callbacks from a consuming component.
 *   2. Opens a fetch-based SSE stream via `consumeSSEStream`, which yields parsed
 *      `SSEEvent` objects from the response body's ReadableStream.
 *   3. Dispatches each event to the appropriate callback (`onToken`, `onDone`,
 *      `onError`, etc.), translating raw event data into typed payloads.
 *   4. Manages the connection lifecycle — connecting, reconnecting with exponential
 *      backoff, aborting, and surfacing the current connection state so the UI can
 *      render spinners, error banners, or re-connect buttons.
 *
 * ## State Machine
 * ```
 * idle ──► connecting ──► connected ──► idle  (clean completion / manual disconnect)
 *   ▲                        │
 *   │                        ▼
 *   │               reconnecting ──► connected  (retry succeeded)
 *   │                        │
 *   │                        ▼
 *   └────────────────── failed                (retries exhausted)
 * ```
 *
 * ## Key Behaviors
 * - Only one active connection at a time; calling `connect` again aborts the
 *   previous stream.
 * - Failed connections are retried up to `MAX_RETRIES` (3) times with delays
 *   [1s, 2s, 4s] before entering the `'failed'` state.
 * - All stream iterations and retry attempts check `controller.signal.aborted`
 *   so that `disconnect()` (or a new `connect()` call) can tear everything down
 *   immediately without leaving stale Promises running.
 */

import { useRef, useCallback, useState } from 'react';
import { consumeSSEStream } from '../services/sse';
import type { SSEEvent } from '../types/chat';

/**
 * Possible states of the SSE connection lifecycle.
 *
 * - `'idle'`        — No active connection and no retry in progress.
 * - `'connecting'`  — Initial connection attempt is underway.
 * - `'connected'`   — Stream is open and events are flowing.
 * - `'reconnecting'`— A previous attempt failed; waiting to retry.
 * - `'failed'`      — All retries exhausted; connection cannot be established.
 */
export type SSEConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/**
 * Callbacks that the hook consumer provides to react to SSE events.
 *
 * Every callback is optional — the hook silently skips events that have no
 * registered handler.
 */
interface UseSSEOptions {
  /** Fires for each token (word/piece) received from the LLM. */
  onToken?: (text: string) => void;
  /** Fires when the LLM returns source references / citations. */
  onReferences?: (references: unknown) => void;
  /** Fires when the stream signals a clean completion (`event: done`). */
  onDone?: (data: unknown) => void;
  /** Fires on stream-level errors OR after all retries are exhausted. */
  onError?: (error: { code: string; message: string }) => void;
  /** Fires when the backend reports a status transition (e.g. "thinking"). */
  onStatus?: (stage: string) => void;
}

/** Maximum number of automatic reconnection attempts before surfacing a failure. */
const MAX_RETRIES = 3;
/** Exponential backoff delays for retries 1, 2, and 3 (in milliseconds). */
const RETRY_DELAYS = [1000, 2000, 4000]; // ms

/**
 * React hook that manages the full lifecycle of a fetch-based SSE connection.
 *
 * Rather than opening a stream immediately on mount, the hook exposes a
 * `connect` function so the consumer controls when the request fires (e.g.
 * after the user submits a prompt). This is important because the SSE endpoint
 * accepts POST requests with a JSON body — it is not a simple auto-connecting
 * EventSource.
 *
 * @returns An object with three members:
 *   - `connectionState` — The current phase of the connection lifecycle
 *     (see {@link SSEConnectionState}). Consumers use this to show
 *     loading spinners, error banners, or re-connect controls.
 *   - `connect`         — Async function that starts (or restarts) the
 *     SSE stream. Accepts a `fetchFn` factory and a set of `UseSSEOptions`
 *     callbacks. Safe to call repeatedly; previous connections are aborted.
 *   - `disconnect`      — Synchronous function that aborts any in-flight
 *     connection or retry loop and resets the state back to `'idle'`.
 */
export function useSSE() {
  // ---- State & Refs -------------------------------------------------------
  // `connectionState` drives UI: spinners, banners, retry buttons.
  const [connectionState, setConnectionState] = useState<SSEConnectionState>('idle');
  // Holds the AbortController for the current (or most recent) stream.
  // Cleared to `null` when disconnected or when a new connection takes over.
  const abortRef = useRef<AbortController | null>(null);
  // Tracks how many consecutive retries have been attempted.
  // Reset to 0 on a successful connection, a manual disconnect, or a clean
  // stream completion (`event: done`).
  const retryCountRef = useRef(0);

  /**
   * Aborts any in-flight SSE connection or pending retry and resets all state.
   *
   * Idempotent — safe to call when already idle. After calling `disconnect`,
   * `connectionState` returns to `'idle'` and the retry counter is zeroed,
   * regardless of the previous state.
   *
   * **Edge case:** If `connect` is in the middle of a `setTimeout` backoff
   * delay, the timer will still fire, but `controller.signal.aborted` will
   * be `true`, so `attemptConnection` exits immediately without making a new
   * request.
   */
  const disconnect = useCallback(() => {
    // Signal the AbortController if one exists, which causes any in-progress
    // fetch to throw an AbortError and any pending retry to bail out.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Reset UI-visible state and retry counter.
    setConnectionState('idle');
    retryCountRef.current = 0;
  }, []);

  /**
   * Initiates (or re-initiates) an SSE connection.
   *
   * **Side effect:** Aborts any previous connection first, ensuring only one
   * active stream at a time.
   *
   * **Retry logic:** On failure, automatically retries up to `MAX_RETRIES`
   * times with exponential backoff delays defined in `RETRY_DELAYS`. Each
   * retry increments `retryCountRef`. If all retries are exhausted, the
   * state transitions to `'failed'` and `onError` is called with code
   * `'CONNECTION_FAILED'`.
   *
   * **Cancellation:** Checks `controller.signal.aborted` before every retry
   * attempt and at the top of each SSE event loop iteration, allowing
   * `disconnect()` (or a subsequent `connect()` call) to tear down the
   * pipeline cleanly.
   *
   * @param fetchFn  - A factory function that returns a `fetch` `Response`
   *                   Promise. Called fresh on each attempt (including
   *                   retries) so the consumer can supply new credentials
   *                   or request bodies if needed.
   * @param callbacks - An object of optional event handlers
   *                    ({@link UseSSEOptions}) invoked as SSE events arrive.
   * @returns A `Promise<void>` that settles after the stream ends (clean
   *          completion, error, or abort). The consumer does not typically
   *          `await` this Promise; it is returned for lifecycle tracing.
   */
  const connect = useCallback(
    async (
      fetchFn: () => Promise<Response>,
      callbacks: UseSSEOptions,
    ) => {
      // ---- Cancel any previous connection ----------------------------------
      // This ensures we never have two overlapping streams for the same hook
      // instance, which would cause duplicate state transitions and memory
      // leaks from orphaned AbortControllers.
      if (abortRef.current) {
        abortRef.current.abort();
      }

      // ---- Create a fresh AbortController for this connection cycle --------
      const controller = new AbortController();
      abortRef.current = controller;

      /**
       * Recursive helper that performs a single connection attempt and
       * schedules retries on failure.
       *
       * Each invocation does:
       *   1. Update `connectionState` (`'connecting'` or `'reconnecting'`).
       *   2. Apply backoff delay if this is a retry.
       *   3. Check for abort before proceeding.
       *   4. Execute `fetchFn` and validate the HTTP response.
       *   5. Iterate the SSE stream, dispatching events to callbacks.
       *   6. On failure, either recurse (retry) or transition to `'failed'`.
       *
       * @returns A `Promise<void>` — resolves when the stream ends or the
       *          attempt is aborted.
       */
      const attemptConnection = async (): Promise<void> => {
        try {
          // ---- Phase 1: Set state & apply backoff --------------------------
          if (retryCountRef.current > 0) {
            setConnectionState('reconnecting');
            // Pick the appropriate delay from the exponential backoff table.
            // Clamp to the last element if retryCount somehow exceeds the
            // array length (defensive coding).
            const delay = RETRY_DELAYS[Math.min(retryCountRef.current - 1, RETRY_DELAYS.length - 1)];
            // Wait for the backoff period. This Promise is NOT cancelled by
            // the AbortController — the abort check on the next line handles
            // early exit.
            await new Promise((r) => setTimeout(r, delay));
          } else {
            setConnectionState('connecting');
          }

          // ---- Phase 2: Abort check after delay ----------------------------
          // If disconnect() was called during the backoff delay, bail out
          // immediately without making a network request.
          if (controller.signal.aborted) return;

          // ---- Phase 3: Execute the fetch ----------------------------------
          const response = await fetchFn();

          // Treat any non-2xx response as a retryable error. The stream
          // cannot be consumed from a failed response, so we throw to enter
          // the catch block.
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          // ---- Phase 4: Connection established -----------------------------
          setConnectionState('connected');
          // Reset retry counter on success so the next failure starts from
          // retry 1 again (not from where a previous cycle left off).
          retryCountRef.current = 0;

          // ---- Phase 5: Consume the SSE stream -----------------------------
          // `consumeSSEStream` is an async generator that yields parsed
          // SSEEvent objects as they arrive on the ReadableStream.
          for await (const event of consumeSSEStream(response)) {
            // If the stream was aborted mid-iteration (e.g. user navigated
            // away or called disconnect()), stop processing immediately.
            if (controller.signal.aborted) break;

            // Dispatch the event to the appropriate callback based on the
            // `event` field of the SSE message.
            switch (event.event) {
              case 'token': {
                // The `data` field may arrive as a plain string (legacy
                // format) or as a parsed object with a `text` property.
                // Normalize to a string before passing to onToken.
                const d = event.data;
                const text = typeof d === 'string' ? d : (d as any)?.text || '';
                callbacks.onToken?.(text);
                break;
              }
              case 'references': {
                // `data` may be `{ references: [...] }` or a bare array.
                // Extract the array in either case.
                const d = event.data as any;
                const refs = d?.references || d || [];
                callbacks.onReferences?.(refs);
                break;
              }
              case 'done':
                // Clean completion — invoke callback and transition to idle.
                // No retry is attempted because this is a success signal.
                callbacks.onDone?.(event.data);
                // Transition to idle synchronously; this also signals the UI
                // that the stream has finished cleanly.
                setConnectionState('idle');
                return; // Exit the for-await loop and the attemptConnection fn.

              case 'error': {
                // Server-sent error event — treated as terminal for this
                // attempt (NO retry). The backend has explicitly signaled
                // an unrecoverable condition.
                const d = event.data as any;
                callbacks.onError?.({
                  code: d?.code || 'UNKNOWN',
                  message: d?.message || '未知错误',
                });
                setConnectionState('idle');
                return; // No retry on server-sent errors.

              }
              case 'status': {
                // Progress/status update from the backend (e.g. "thinking",
                // "searching"). Used to drive UI status indicators.
                const d = event.data as any;
                callbacks.onStatus?.(d?.stage || '');
                break;
              }
              // Unknown event types are silently ignored — they may be added
              // by future backend versions without breaking the client.
            }
          }
        } catch (err: any) {
          // ---- Phase 6: Error handling & retry logic -----------------------
          // If the connection was intentionally aborted, do nothing — the
          // caller (disconnect or a new connect) has already handled cleanup.
          // Note: fetch throws an AbortError when the AbortController is
          // signalled, so this check catches both manual disconnects and
          // takeover-by-new-connect scenarios.
          if (controller.signal.aborted) return;

          // Attempt to retry if we haven't hit the ceiling.
          // `retryCountRef` is incremented BEFORE recursing so the next
          // iteration applies the correct backoff delay.
          if (retryCountRef.current < MAX_RETRIES) {
            retryCountRef.current++;
            // Tail-call recursion: the new attemptConnection Promise is
            // returned so the caller can await the full retry chain.
            return attemptConnection();
          }

          // ---- Retries exhausted — enter terminal 'failed' state -----------
          setConnectionState('failed');
          callbacks.onError?.({
            code: 'CONNECTION_FAILED',
            message: `连接失败，已重试 ${MAX_RETRIES} 次: ${err.message}`,
          });
        }
      };

      // ---- Kick off the first connection attempt ---------------------------
      // The returned Promise is intentionally not awaited here — the connect
      // function returns immediately after starting the async process. The
      // consumer monitors progress via `connectionState` and the callbacks.
      attemptConnection();
    },
    // Empty dependency array: `connect` identity is stable for the lifetime
    // of the component. All mutable state is stored in refs, so we never
    // need to recreate this callback.
    [],
  );

  return { connectionState, connect, disconnect };
}
