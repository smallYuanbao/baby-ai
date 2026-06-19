/**
 * @file vite-env.d.ts
 * @description TypeScript declaration file for Vite environment variable type augmentation.
 *
 * This file extends Vite's built-in type definitions to provide type-safe access to
 * custom environment variables exposed via `import.meta.env`. Vite uses a
 * client-side `import.meta.env` mechanism (not `process.env`) to expose select
 * environment variables at build time — only variables prefixed with `VITE_` are
 * included by default.
 *
 * By augmenting the `ImportMetaEnv` and `ImportMeta` interfaces, this file ensures
 * that TypeScript-aware editors and the compiler recognise custom env vars and
 * provide autocompletion, type-checking, and documentation hints for them.
 *
 * Role in the project:
 * - Centralises the contract between the build system (Vite) and the application code.
 * - Prevents typos and invalid accesses to `import.meta.env.*` at compile time.
 * - Serves as the canonical registry of all client-side environment variables.
 *
 * @see https://vitejs.dev/guide/env-and-mode.html
 */

// Triple-slash directive that pulls in Vite's own client-side type definitions.
// This brings in the base ImportMetaEnv and ImportMeta interfaces so that the
// augmentations below can merge with them (TypeScript declaration merging).
/// <reference types="vite/client" />

/**
 * @description Augments the base `ImportMetaEnv` interface shipped by Vite with
 *              project-specific environment variables.
 *
 * Each property declared here corresponds to an environment variable that Vite
 * will expose on `import.meta.env` at build time. Properties are marked
 * `readonly` because these values are injected as string literals during the
 * build and cannot be reassigned at runtime.
 *
 * @see ImportMeta.env
 */
interface ImportMetaEnv {
  /**
   * The base URL of the backend API server.
   *
   * This value is used by the HTTP client (e.g. axios or fetch wrappers) to
   * construct request URLs without hardcoding the server address. It typically
   * differs between development (e.g. `http://localhost:3000`) and production
   * (e.g. `https://api.example.com`).
   *
   * Configured via the `VITE_API_BASE_URL` environment variable in `.env`,
   * `.env.development`, or `.env.production` files at the project root.
   *
   * @readonly — injected at build time by Vite.
   */
  readonly VITE_API_BASE_URL: string;
}

/**
 * @description Augments the `ImportMeta` interface so that the `env` property
 *              resolves to the project-specific `ImportMetaEnv` above instead
 *              of the default (narrower) Vite type.
 *
 * Without this augmentation, `import.meta.env.VITE_API_BASE_URL` would trigger
 * a TypeScript error because the variable would not be known to the compiler.
 * With this declaration, `import.meta.env` is typed as the **intersection** of
 * Vite's built-in env vars and the custom ones defined in `ImportMetaEnv`.
 *
 * @see ImportMetaEnv
 */
interface ImportMeta {
  /**
   * Build-time environment variables injected by Vite.
   *
   * The type of this property is declared as `ImportMetaEnv` so that TypeScript
   * can verify every access against the known set of variables. The actual
   * runtime value is a frozen (immutable) object populated by Vite via string
   * substitution at build time.
   *
   * @returns An object containing all `VITE_`-prefixed environment variables
   *          available at the time the project was built, plus a few built-in
   *          keys such as `MODE`, `BASE_URL`, `PROD`, `DEV`, and `SSR`.
   */
  readonly env: ImportMetaEnv;
}
