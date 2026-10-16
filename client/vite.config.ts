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
 * - Pins the dev server to port 5180 with `strictPort`, and proxies `/api/*`
 *   to the backend on port 8010 (see the port table at the top of this file)
 *   (python-server / FastAPI), avoiding CORS issues during local development.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ============================================================================
//  端口分配 —— 全机唯一的真相在这里,别的项目那一半在各自的 vite.config.ts
// ============================================================================
//
//   evalflow     前端 5173    后端 8002    ← 保持不动(它 3 个文档/e2e/CORS 都按这个写)
//   baby-ai      前端 5180    后端 8010    ← 本文件
//   BGE 精排            8011
//
// 为什么要挪:这三个项目原先把前端**都**写死在 5173,后端挤在 8000/8002 一带。
// 先起的占住,后起的被 Vite 默默顺延(strictPort 默认 false),
// 而且后端的 `/api` 代理会打到"那个端口上碰巧坐着的人"身上 —— 症状却是
// 业务接口 404,和病因隔了十万八千里。见 scripts/devguard.mjs 的说明。
//
// 留了 env 口子(同时跑两份代码时用得上),但**默认值必须互不重叠**。
const DEV_PORT = Number(process.env.VITE_DEV_PORT ?? 5180);
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8010';

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
    /** 端口见文件顶部的分配表 —— 不要改回 5173,那是 evalflow 的位置。 */
    port: DEV_PORT,

    /**
     * 端口被占时**直接报错退出**,而不是默默顺延到下一个。
     *
     * Vite 默认是 `false`:5173 若被占,它会安静地换 5174、5175……
     * 后果是「我打开 localhost:5173」这句话本身就不可信 ——
     * 你可能正在看**另一个项目**的页面,也可能自己的服务被挤到了 5175 却毫无察觉。
     * 响亮地失败,好过安静地跑到别处去。
     */
    strictPort: true,

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
     * During development, the React app runs on port 5180 while the backend
     * API server runs on port 8010（python-server）。Without proxying, API calls
     * from the browser to a different port would trigger CORS preflight requests.
     * These proxy rules forward matching requests to the backend transparently,
     * so the browser sees them as same-origin.
     */
    proxy: {
      // 单后端：所有 /api 请求统一走 python-server。
      // growth/play/upload/chat/health 已全部迁移到 FastAPI，TS server（8020）
      // 不再承担业务流量。
      '/api': {
        /**
         * Backend API server base URL.
         * All requests whose path starts with `/api` are forwarded here.
         */
        // 端口见文件顶部:8010。用 BACKEND_URL 可覆盖。
        //
        // ⚠️ 代理是**无条件转发**的 —— 它不校验对面是谁。所以只要 8010 上坐着
        // 任何别的服务,这里的请求就会安静地打到那个服务上。真正的防线是
        // `npm run dev` 开头跑的 scripts/devguard.mjs:它在启动前就问一遍
        // /api/health,确认对面自报的名字是 baby-ai。
        target: BACKEND_URL,

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
