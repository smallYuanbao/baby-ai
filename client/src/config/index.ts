/**
 * @file config/index.ts
 * @description Centralized application configuration for the baby-ai client.
 *
 * This module serves as the single source of truth for runtime configuration values
 * consumed across the client application. It reads environment-specific settings
 * injected at build time by Vite (via `import.meta.env`) and applies sensible
 * fallback defaults for local development.
 *
 * Purpose:
 * - Decouples environment-dependent values (API URLs, feature flags, etc.) from
 *   the rest of the codebase so that components and services never hard-code
 *   environment-specific logic.
 * - Provides a single place to audit and update configuration as the application
 *   grows — new settings should be added here rather than scattered through the
 *   source tree.
 *
 * Usage:
 *   import { config } from '@/config';
 *   const resp = await fetch(`${config.apiBaseUrl}/health`);
 *
 * @module config
 */

/**
 * @description The top-level runtime configuration object consumed by the client.
 *
 * All environment-dependent values are read from Vite-supplied `import.meta.env`
 * globals (prefixed with `VITE_` as required by Vite's env var whitelisting).
 * When a variable is absent (e.g., in local dev without a `.env` override), the
 * inline fallback value is used.
 */
export const config = {
  /**
   * @description Base URL (scheme + host + optional port + optional prefix path)
   *              for the backend API server.
   *
   * - In production/staging builds, CI injects `VITE_API_BASE_URL` so the client
   *   points at the correct environment's API gateway.
   * - In local development the variable is typically unset, so the fallback
   *   `/api` causes requests to be routed through the Vite dev server's proxy
   *   (configured in `vite.config.ts`) — no CORS issues and no hard-coded ports.
   *
   * @example "https://api.baby-ai.example.com"
   * @example "/api" (local dev fallback — proxied by Vite)
   */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '/api',
};
