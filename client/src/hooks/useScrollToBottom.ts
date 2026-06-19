import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * `useScrollToBottom` — Chat message-list auto-scroll and "scroll to bottom" affordance.
 *
 * ## Role in the data flow
 *
 * This hook sits between a scrollable message container (the DOM) and the
 * message-list data source.  Whenever the dependency array signals that new
 * messages have arrived, the hook decides whether to scroll:
 *
 * - If the user is **already** near the bottom (i.e. actively following the
 *   conversation), new content causes an automatic, instant scroll to the
 *   bottom — the user stays "pinned" to the latest message.
 * - If the user has **scrolled up** to read older messages, the hook shows a
 *   "back to bottom" floating button instead of disrupting their view.  The
 *   user can tap that button (or call `scrollToBottom`) to rejoin the live
 *   conversation and resume auto-scrolling.
 *
 * ## What it manages
 *
 * - **Scroll container ref** (`containerRef`) — attach this to the
 *   `overflow-y: auto` / `overflow-y: scroll` element that wraps the message
 *   list.
 * - **Proximity to bottom** (`isAtBottom`) — true when the container is
 *   scrolled within `threshold` pixels of its `scrollHeight`.
 * - **Button visibility** (`showScrollButton`) — derived from `!isAtBottom`;
 *   controls a floating "scroll to bottom" UI element.
 * - **Scroll action** (`scrollToBottom`) — imperative helper that the
 *   consumer can call directly (e.g. when the user clicks the button, or after
 *   sending a message).
 * - **Scroll event handler** (`handleScroll`) — on-scroll callback that
 *   re-evaluates proximity and updates `isAtBottom` / `showScrollButton`.
 *
 * ## Edge cases handled
 *
 * - **Empty container**: if `containerRef.current` is `null` (e.g. the
 *   component hasn't mounted yet), all DOM reads/writes are guarded and
 *   become no-ops.
 * - **Content shrinking**: the proximity check uses `scrollHeight - scrollTop
 *   - clientHeight`, which works even when messages are removed or the
 *   container is resized.
 * - **Rapid consecutive deps changes**: `useCallback`-wrapped helpers are
 *   stable references, avoiding unnecessary re-renders of child components
 *   that receive them as props.  The `useEffect` only fires when `deps`
 *   elements change identity, not on every render.
 * - **Threshold**: the 100 px fudge factor means the user doesn't have to be
 *   pixel-perfect at the very bottom for auto-scroll to remain active.
 */

/**
 * React hook that manages auto-scroll behaviour for a chat-style message list.
 *
 * @param deps - Dependency array (usually the message list or the last-message
 *   ID).  When any element in this array changes identity, the hook
 *   automatically scrolls to the bottom **if** the user is already near the
 *   bottom.  This is typically `[messages]` or `[messages.length]`.
 *
 * @returns An object with the following properties:
 *   - **containerRef** (`React.RefObject<HTMLDivElement>`) — Attach to the
 *     scrollable message-list wrapper.  The hook reads `scrollHeight`,
 *     `scrollTop`, and `clientHeight` from this element.
 *   - **isAtBottom** (`boolean`) — `true` when the viewport is within the
 *     proximity threshold of the bottom.  Useful for hiding the "typing
 *     indicator" or other bottom-docked UI when the user scrolls away.
 *   - **showScrollButton** (`boolean`) — `true` when the user has scrolled
 *     away from the bottom and the floating "back to bottom" button should
 *     be visible.
 *   - **scrollToBottom** (`(smooth?: boolean) => void`) — Imperatively scroll
 *     the container to the bottom.  Pass `false` for an instant jump (used
 *     internally when new messages arrive); pass `true` (the default) for a
 *     smooth animation (used when the user manually clicks the button).
 *   - **handleScroll** (`() => void`) — On-scroll callback.  Attach to the
 *     container's `onScroll` prop so the hook can track scroll position and
 *     recompute `isAtBottom` / `showScrollButton`.
 */
export function useScrollToBottom(deps: unknown[]) {
  // ------------------------------------------------------------------
  // Refs — stable across renders, never trigger re-renders
  // ------------------------------------------------------------------

  /** Ref to the scrollable DOM container that wraps the message list. */
  const containerRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------------
  // State — triggers re-renders when scroll position changes
  // ------------------------------------------------------------------

  /**
   * Whether the container's viewport is within the threshold of the bottom.
   * Initialised to `true` because an empty message list is conceptually
   * "at the bottom".
   */
  const [isAtBottom, setIsAtBottom] = useState(true);

  /**
   * Whether the floating "back to bottom" button should be visible.
   * Derived from `!isAtBottom`: when the user scrolls up, this flips to
   * `true`; when they scroll back down (or programmatically jump to the
   * bottom), it resets to `false`.
   */
  const [showScrollButton, setShowScrollButton] = useState(false);

  // ------------------------------------------------------------------
  // Memoised helpers — stable references avoid prop-drift in children
  // ------------------------------------------------------------------

  /**
   * Imperatively scroll the container to its bottom edge.
   *
   * Also resets `showScrollButton` to `false` and `isAtBottom` to `true`,
   * effectively re-entering "auto-scroll" mode.
   *
   * Guarded against a null ref: if the container isn't mounted yet, this
   * is a safe no-op.
   *
   * @param smooth - When `false`, scrolls instantly (`behavior: 'instant'`).
   *   Used for automatic scrolls on new-message arrival so the user isn't
   *   distracted by animation.  Defaults to `true` (smooth) for manual
   *   invocations like button clicks.
   */
  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (!el) return; // Guard: container not mounted yet
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
    setShowScrollButton(false);
    setIsAtBottom(true);
  }, []);

  /**
   * On-scroll handler that re-evaluates the user's proximity to the bottom.
   *
   * Uses a `threshold` (in px) to provide a forgiving "near the bottom" zone
   * — the user doesn't need to be at exactly `scrollHeight` for auto-scroll
   * to consider them "at the bottom".
   *
   * Guarded against a null ref: if the container ref isn't populated yet,
   * this is a safe no-op.
   */
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return; // Guard: container not mounted yet

    const threshold = 100; // px — forgiving zone near the bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
    setShowScrollButton(!atBottom);
  }, []);

  // ------------------------------------------------------------------
  // Side-effect — auto-scroll when deps change
  // ------------------------------------------------------------------

  /**
   * When `deps` change (indicating new content arrived), auto-scroll to the
   * bottom **only if** the user is already near the bottom.  If the user has
   * scrolled up to read history, we leave their view alone so they aren't
   * yanked away.
   *
   * `scrollToBottom(false)` uses instant scrolling here to avoid a
   * disorienting animation when messages stream in rapidly.
   *
   * Note: there is no cleanup function because this effect only calls
   * `scrollToBottom`, which does not register any listeners, timers, or
   * subscriptions that need teardown.
   */
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    /** Attach to the scrollable message-list wrapper element. */
    containerRef,
    /** Whether the viewport is near the bottom (within the threshold). */
    isAtBottom,
    /** Whether the floating "back to bottom" button should be visible. */
    showScrollButton,
    /** Imperatively scroll to the bottom. `true` = smooth, `false` = instant. */
    scrollToBottom,
    /** Attach to the container's `onScroll` prop to track scroll position. */
    handleScroll,
  };
}
