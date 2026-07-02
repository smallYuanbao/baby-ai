/**
 * Database layer barrel export.
 *
 * Re-exports the shared connection instance and the migration runner so the
 * rest of the server imports from a single entry point.
 *
 * @module db
 */

export { db } from './connection.js';
export { runMigrations } from './migrate.js';
