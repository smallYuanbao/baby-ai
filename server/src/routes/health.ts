/**
 * Health Check Routes
 *
 * @fileoverview Defines the health check endpoint used by load balancers,
 * orchestration platforms, and monitoring tools to verify that the server
 * process is alive and responsive. This is a lightweight, unauthenticated
 * endpoint that reports uptime and downstream service reachability.
 *
 * Routes:
 *   GET /health — Returns server health status, uptime, current timestamp,
 *                 and the connection state of each downstream service.
 *
 * Usage:
 *   Mount this router in the Express app under the "/health" path prefix:
 *     import { healthRouter } from './routes/health';
 *     app.use('/health', healthRouter);
 *
 * The individual handler below listens on "/" relative to that mount point,
 * so the full public path becomes GET /health.
 */

import { Router } from 'express';

export const healthRouter = Router();

/**
 * Timestamp (ms since Unix epoch) captured once at module load time.
 *
 * Used to compute server uptime on every health check request without
 * relying on `process.uptime()` (which resets for some process managers).
 * The value is frozen at import — it represents the point when the route
 * file was first evaluated, which in typical Express apps happens at
 * startup before the server begins accepting connections.
 */
const startTime = Date.now();

/**
 * GET /
 *
 * Health check endpoint. Returns a JSON payload describing the current
 * state of the server process and its known downstream dependencies.
 *
 * HTTP Method: GET
 * Path:        / (relative to the router mount point; typically /health)
 * Auth:        None — this endpoint is intentionally unauthenticated so
 *              that load balancers, container orchestrators (Kubernetes
 *              liveness/readiness probes), and external monitoring services
 *              (e.g. UptimeRobot, Pingdom) can poll it without credentials.
 *
 * @param {import('express').Request}  _req — Express request object
 *   (unused — the endpoint takes no query parameters, body, or headers
 *   beyond the standard HTTP request).
 * @returns {import('express').Response} res — Express response object
 *   that sends a JSON body with the following shape:
 *
 *   {
 *     status:    string       — Always "ok" while the process is alive.
 *                              A non-200 response or connection refusal
 *                              signals an unhealthy state to consumers.
 *     uptime:    number        — Server uptime in whole seconds, computed
 *                               as (currentTime - startTime) / 1000
 *                               rounded down.
 *     timestamp: string (ISO) — ISO-8601 timestamp of when this response
 *                               was generated (e.g. "2026-06-19T…").
 *     services: {
 *       deepseek: string      — Reachability of the DeepSeek LLM API
 *                               ("unknown" when not yet wired; intended
 *                               future values: "ok", "error").
 *       ollama:   string      — Reachability of the local Ollama instance
 *                               ("unknown" when not yet wired).
 *       chroma:   string      — Reachability of the Chroma vector database
 *                               ("unknown" when not yet wired).
 *     }
 *   }
 *
 * @description
 * **Request handling details:**
 * - No request parsing is performed — `_req` is ignored entirely. The
 *   endpoint accepts GET, HEAD, and (implicitly via Express) OPTIONS
 *   requests without any body, query string, or custom headers.
 *
 * **Validation:**
 * - None required. Since the endpoint accepts no input, there is nothing
 *   to validate, sanitize, or reject. A request to this route will always
 *   receive a 200 response as long as the Express app is handling requests.
 *
 * **Response formatting:**
 * - `uptime` is computed fresh on every call by subtracting the module-level
 *   `startTime` from `Date.now()`, then dividing by 1000 and flooring.
 *   This gives a monotonically increasing integer in seconds.
 * - `timestamp` is generated via `new Date().toISOString()` so every
 *   response carries the exact moment it was produced.
 * - All three `services.*` fields are hardcoded to `"unknown"` because
 *   actual health probes for DeepSeek, Ollama, and Chroma have not yet been
 *   implemented. When those integrations are added, this handler should be
 *   updated to perform lightweight connectivity checks (e.g. a HEAD request
 *   or a trivial API call) and report `"ok"` or `"error"` accordingly.
 *
 * **Error scenarios and edge cases:**
 * - **Uptime at startup:** If this endpoint is hit immediately after the
 *   process starts, `uptime` will be `0` (seconds). This is valid and
 *   should not be treated as an error by consumers.
 * - **Clock skew / NTP adjustments:** `Date.now()` relies on the system
 *   clock. Large NTP corrections could cause `uptime` to jump forward or
 *   backward. This is an accepted limitation for a simple health probe.
 * - **process uptime vs module uptime:** `process.uptime()` is deliberately
 *   avoided because some process managers (e.g. PM2 in cluster mode) can
 *   reset it. Using a module-level `startTime` guarantees monotonicity
 *   for the lifetime of *this* module's evaluation.
 * - **Express error handling:** This synchronous handler never throws, so
 *   no try/catch is needed. If Express itself fails (e.g. out of memory,
 *   event loop blocked), no response is sent at all, which is the correct
 *   failure mode for a health check — the consumer will see a timeout or
 *   connection refusal.
 * - **Service statuses are static:** Currently all three service fields
 *   always return `"unknown"`. Consumers MUST NOT rely on these values for
 *   critical routing decisions until real probes are implemented.
 * - **No rate limiting:** There is no rate limiting at this layer. If
 *   needed, apply it via middleware before this router in the chain.
 * - **Caching:** The response is not explicitly marked as non-cacheable.
 *   Reverse proxies may cache it. Consider adding `Cache-Control: no-cache`
 *   headers if freshness is critical.
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    services: {
      deepseek: 'unknown',
      ollama: 'unknown',
      chroma: 'unknown',
    },
  });
});
