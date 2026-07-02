/**
 * Database migration module.
 *
 * Runs idempotent schema migrations on the SQLite database. Each migration
 * uses `CREATE TABLE IF NOT EXISTS` so the module is safe to call on every
 * server startup — existing tables are left untouched.
 *
 * Called once from `createApp()` (or the entry point) before any routes
 * are registered.
 *
 * @module db/migrate
 */

import { db } from './connection.js';
import logger from '../utils/logger.js';

/**
 * Run all pending migrations.
 *
 * Migrations are ordered by dependency. Currently two tables:
 *
 * 1. `users` — core user accounts.
 * 2. `refresh_tokens` — issued refresh tokens for JWT rotation.
 *
 * Both use TEXT timestamps in ISO-8601 format (consistent with the existing
 * `growthStore` JSON-on-disk convention).
 */
export function runMigrations(): void {
  logger.info('[db] 执行数据库迁移...');

  // ---- users table ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname      TEXT DEFAULT '',
      avatar        TEXT DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---- refresh_tokens table ----
  // Each user can hold multiple refresh tokens (e.g. one per device).
  // Tokens are revoked by row deletion (on logout) or naturally expire.
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Index for fast token lookup during refresh.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token
      ON refresh_tokens(token);
  `);

  // Index for cleaning up expired tokens or listing user sessions.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
      ON refresh_tokens(user_id);
  `);

  logger.info('[db] 数据库迁移完成');
}
