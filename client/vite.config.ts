/**
 * @file vite.config.ts
 * @description Vite build tool configuration for the baby-ai client application.
 *
 * This file defines the development server settings, plugin integrations,
 * and network proxy rules for the React-based frontend. It is the central
 * configuration entry point consumed by Vite during `vite dev`, `vite build`,
 * and `vite preview` commands.
 *
 * Key responsibilities:
 * - Registers the [at]vitejs/plugin-react plugin for JSX transform, Fast Refresh,
 *   and other React-specific optimisations.
 * - Configures the dev server to listen on all network interfaces (0.0.0.0)
 *   so the app is accessible from other devices on the local network (e.g. for
 *   mobile or cross-machine testing).
 * - Proxies `/api/*` requests to the backend server running on port 3001,
 *   avoiding CORS issues during local development.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Exported Vite configuration object.
 *
 * Built via {@link defineConfig} to provide IDE autocompletion and type-safety
 * for all Vite configuration properties.
 *
 * @returns {import('vite').UserConfig} The resolved Vite configuration.
 */
export default defineConfig({
  /** Vite plugins applied during dev and build. */
  plugins: [
    /**
     * [at]vitejs/plugin-react — enables React Fast Refresh (HMR),
     * automatic JSX runtime detection, and Babel-based transforms
     * where needed.
     */
    react(),
  ],

  /** Development server configuration (vite dev only). */
  server: {
    /** Port the dev server binds to. 5173 is Vite's default for React projects. */
    port: 5173,

    /**
     * Binds the dev server to all available network interfaces (0.0.0.0)
     * instead of just localhost. This allows devices on the same LAN —
     * e.g. phones, tablets, or other workstations — to access the dev server
     * via the host machine's IP address, which is useful for cross-device
     * testing and demos.
     */
    host: '0.0.0.0',

    /**
     * Reverse-proxy rules applied by the Vite dev server.
     *
     * During development, the React app runs on port 5173 while the backend
     * API server runs on port 3001. Without proxying, API calls from the
     * browser to a different port would trigger CORS preflight requests.
     * These proxy rules forward matching requests to the backend transparently,
     * so the browser sees them as same-origin.
     */
    proxy: {
      '/api': {
        /**
         * Backend API server base URL.
         * All requests whose path starts with `/api` are forwarded here.
         */
        target: 'http://localhost:3001',

        /**
         * Changes the `Origin` header of the proxied request to match the
         * target URL. Some backend frameworks (e.g. Express with CORS
         * middleware) inspect the Origin header; setting this to `true`
         * prevents the backend from rejecting the request due to an
         * unexpected origin.
         */
        changeOrigin: true,
      },
    },
  },
});
