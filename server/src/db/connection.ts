/**
 * SQLite database connection module.
 *
 * Creates (or opens) a single SQLite database file under `server/data/baby-ai.db`
 * and enables WAL mode for better concurrent read performance.
 *
 * Usage:
 * ```ts
 * import { db } from './db/connection.js';
 * const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
 * ```
 *
 * @module db/connection
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the SQLite database file. */
const DB_PATH = path.resolve(__dirname, '../../data/baby-ai.db');

/**
 * Singleton SQLite database instance.
 *
 * - WAL journal mode allows concurrent reads without blocking writers.
 * - `verbose` is intentionally left unset to keep logs clean; enable during
 *   debugging by passing `console.log`.
 */
export const db: DatabaseType = new Database(DB_PATH);

// Enable Write-Ahead Logging — readers don't block writers and vice versa.
db.pragma('journal_mode = WAL');
// Enable foreign key enforcement (disabled by default in SQLite).
db.pragma('foreign_keys = ON');
