/**
 * Logger Service
 *
 * @fileoverview Centralized logging utility that wraps the native `console` API
 * with structured, timestamped output. Every log line is prefixed with an
 * ISO-8601 timestamp and a severity emoji so operators can scan logs visually
 * in development, staging, and production.
 *
 * **Architecture role**
 *
 * This module is the **single logging sink** for the entire server process.
 * All other modules import it and call its leveled methods (`info`, `warn`,
 * `error`, `debug`) rather than reaching for `console.*` directly.  That
 * discipline delivers three guarantees:
 *
 * 1. **Consistent formatting** — every line carries the same timestamp prefix
 *    and severity marker, which simplifies grep / log-aggregator parsing.
 * 2. **Environment-aware noise control** — `debug` messages are silently
 *    dropped when `NODE_ENV=production` (or unset), keeping production logs
 *    clean without sprinkling conditionals across the codebase.
 * 3. **Single point of change** — if the project later adopts a structured
 *    logger (pino, winston, etc.), emits JSON, or integrates with an APM
 *    provider, only this file needs to be modified.
 *
 * **Usage**
 *
 * ```ts
 * import logger from './utils/logger';
 *
 * logger.info('Server listening', { port: 3000 });
 * logger.warn('Rate-limit approaching', { remaining: 5 });
 * logger.error('Unhandled rejection', err);
 * logger.debug('Request body', body); // auto-suppressed in production
 * ```
 *
 * **Production behaviour**
 *
 * - `info`, `warn`, `error` — always emitted.
 * - `debug` — emitted **only** when `NODE_ENV !== 'production'`.  In all other
 *   environments (development, test, staging, CI) debug output is on by
 *   default so developers never need to toggle a flag.
 */

/**
 * Whether the process is running in a non-production environment.
 *
 * Evaluated **once at module-load time** (not per-call), so switching
 * NODE_ENV at runtime has no effect on debug gating.  This is intentional:
 * a statically-known value avoids the branch-prediction cost on every debug
 * call and prevents accidental debug leaks in production if the env var is
 * mutated mid-process.
 */
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Shared logger instance consumed by the rest of the server.
 *
 * Each method accepts variadic arguments (matching the `console.*` signature)
 * so callers can pass strings, objects, errors, or any combination thereof.
 *
 * @default — re-exported as the module's default export.
 */
const logger = {
  /**
   * Log an informational message.
   *
   * Used for lifecycle events (startup, shutdown, port binding), successful
   * operations, and any non-error diagnostic that operators may want to see
   * in production.
   *
   * **Output format**: `[ISO-8601] <...args>`
   *
   * @param args - Values to log.  Passed through directly to `console.log`,
   *   so behaviour mirrors the native API (objects are inspected, multiple
   *   args are space-separated).
   *
   * @example
   * logger.info('Server started on port 3000');
   * logger.info('Cache warmed', { entries: 1423, durationMs: 87 });
   */
  info: (...args: unknown[]) => {
    console.log(`[${new Date().toISOString()}]`, ...args);
  },

  /**
   * Log a warning message.
   *
   * Used for recoverable anomalies, deprecation notices, or conditions that
   * deserve operator attention but do not constitute failures (e.g. a
   * rate-limit nearing exhaustion, a degraded fallback path being taken).
   *
   * **Output format**: `[ISO-8601] ⚠️ <...args>`
   *
   * @param args - Values to log.  Passed through directly to `console.warn`.
   *
   * @example
   * logger.warn('Retry budget 80% consumed', { endpoint: '/api/chat' });
   */
  warn: (...args: unknown[]) => {
    console.warn(`[${new Date().toISOString()}] ⚠️`, ...args);
  },

  /**
   * Log an error message.
   *
   * Used for unrecoverable failures, caught exceptions, unhandled rejections,
   * and anything that should trigger an alert or on-call page.  The ❌ emoji
   * acts as a high-visibility marker for grep / log viewers.
   *
   * **Output format**: `[ISO-8601] ❌ <...args>`
   *
   * @param args - Values to log.  Passed through directly to `console.error`.
   *   Error objects are rendered with their stack trace when the runtime
   *   supports it (standard in Node.js and modern browsers).
   *
   * @example
   * logger.error('Failed to connect to Redis', err);
   * logger.error('Invariant violated', { userId, state });
   */
  error: (...args: unknown[]) => {
    console.error(`[${new Date().toISOString()}] ❌`, ...args);
  },

  /**
   * Log a debug-level diagnostic message.
   *
   * Used for verbose, developer-oriented output that should **never** appear
   * in production: request/response payloads, intermediate algorithm state,
   * performance probes, etc.
   *
   * **Gating rule**: this method is a **no-op** when `NODE_ENV ===
   * 'production'` (or when `NODE_ENV` is unset, since the guard treats
   * anything other than explicit inequality to `'production'` as dev).
   *
   * **Rationale**: the guard lives inside this method rather than at every
   * call-site, so authors can sprinkle `logger.debug(...)` liberally without
   * worrying about production noise or performance — the branch is evaluated
   * once per call with a module-level constant (`isDev`), which modern JITs
   * will inline and eliminate when the guard is `false`.
   *
   * **Output format** (when enabled): `[ISO-8601] 🔍 <...args>`
   *
   * @param args - Values to log.  Passed through directly to `console.debug`
   *   only when the guard passes; otherwise discarded entirely (no allocation,
   *   no stringification).
   *
   * @example
   * logger.debug('Incoming request', { method: 'POST', path: '/api/chat' });
   * logger.debug('Embedding vector (first 10 dims)', vec.slice(0, 10));
   */
  debug: (...args: unknown[]) => {
    // Gate debug output to non-production environments only.
    // `isDev` is a module-level constant — see its JSDoc for why it is not
    // re-evaluated on every call.
    if (isDev) {
      console.debug(`[${new Date().toISOString()}] 🔍`, ...args);
    }
  },
};

export default logger;
