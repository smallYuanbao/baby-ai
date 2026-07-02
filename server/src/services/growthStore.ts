/**
 * Growth Store Service
 * ====================
 *
 * **Responsibility:** File-based persistence layer for child growth-tracking data.
 * Each child is stored as an independent JSON file under
 * `server/data/growth/{userId}/`, with all of that child's growth records
 * embedded inline.
 *
 * **User isolation:** Every function requires a `userId` as its first argument.
 * Data for each user is stored in a separate subdirectory, ensuring that
 * authenticated users can only access their own children's data.
 *
 * **Architectural role:**
 * - Sits between the route handlers (HTTP layer) and the filesystem.
 * - Routes never touch `fs` directly; all I/O is mediated through this module.
 * - Isomorphic to a database repository: the exported functions form the full
 *   CRUD surface for both the `Child` and `GrowthRecord` aggregates.
 *
 * **Data layout (one file per child):**
 * ```
 * server/data/growth/
 *   u_abc123/
 *     c_a1b2c3d4.json   ← { childId, name, birthDate, gender, records[], … }
 *     c_e5f6g7h8.json
 *   u_def456/
 *     c_x1y2z3w4.json
 * ```
 *
 * **Concurrency / consistency notes:**
 * - This is a single-process, single-thread store. Reads and writes are atomic
 *   at the OS level for the file sizes we deal with (< 1 MB), but there is NO
 *   cross-request locking. In a multi-instance deployment this would need to be
 *   replaced with a real database. For the current single-box prototype it is
 *   sufficient.
 *
 * **Error handling philosophy:**
 * - Read methods return `null` when the target file does not exist (child not
 *   found). They do **not** throw on missing files.
 * - Write methods throw on filesystem errors (disk full, permission denied,
 *   etc.). Callers (typically route handlers) are expected to catch these and
 *   return 500-level responses.
 * - `listChildren` silently skips corrupt/malformed JSON files so that a single
 *   bad file cannot take down the entire listing endpoint (degradation).
 *
 * @module growthStore
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Child,
  ChildSummary,
  GrowthRecord,
  CreateChild,
  UpdateChild,
  CreateGrowthRecord,
  UpdateGrowthRecord,
} from '../types/growth.js';

// ---- File-system helpers (internal) ----

/** Root directory that contains per-user subdirectories. */
const ROOT_DIR = path.resolve('server/data/growth');

/**
 * Derive the on-disk directory path for a given user.
 *
 * @param userId - The user's unique identifier (e.g. `"u_a1b2c3d4"`).
 * @returns Absolute path to `<ROOT_DIR>/<userId>`.
 *
 * @internal
 */
function userDir(userId: string): string {
  return path.join(ROOT_DIR, userId);
}

/**
 * Derive the on-disk file path for a given child belonging to a user.
 *
 * @param userId  - The user's unique identifier.
 * @param childId - The child's unique identifier (e.g. `"c_a1b2c3d4"`).
 * @returns Absolute path to `<ROOT_DIR>/<userId>/<childId>.json`.
 *
 * @internal
 */
function childPath(userId: string, childId: string): string {
  return path.join(userDir(userId), `${childId}.json`);
}

/**
 * Ensure a user's data directory exists, creating it (and any missing ancestors)
 * if necessary.
 *
 * @throws {Error} When the filesystem rejects the `mkdir` call (permissions,
 *   path is an existing *file*, etc.).
 *
 * @internal
 */
async function ensureDir(userId: string): Promise<void> {
  await fs.mkdir(userDir(userId), { recursive: true });
}

/**
 * Read and parse a child's JSON file from disk.
 *
 * **Pre-condition:** the caller must have already verified (or be prepared to
 * catch) that the file exists.
 *
 * @param userId  - The user's unique identifier.
 * @param childId - The child's unique identifier.
 * @returns The fully-hydrated `Child` object, including all growth records.
 *
 * @throws {Error} When the file does not exist (`ENOENT`).
 * @throws {SyntaxError} When the file content is not valid JSON.
 *
 * @internal
 */
async function readFile(userId: string, childId: string): Promise<Child> {
  const raw = await fs.readFile(childPath(userId, childId), 'utf-8');
  return JSON.parse(raw) as Child;
}

/**
 * Serialize a `Child` object to its JSON file on disk.
 *
 * **Side-effects:**
 * 1. Calls `ensureDir()` so the write will not fail because of a missing
 *    parent directory.
 * 2. Touches `updatedAt` to the current timestamp **every time** a child is
 *    persisted.
 *
 * @param userId - The user's unique identifier.
 * @param child  - The child object to persist.
 *
 * @internal
 */
async function writeFile(userId: string, child: Child): Promise<void> {
  await ensureDir(userId);
  child.updatedAt = new Date().toISOString();
  await fs.writeFile(childPath(userId, child.childId), JSON.stringify(child, null, 2), 'utf-8');
}

// ===================================================================
//  Child CRUD
// ===================================================================

/**
 * List all children belonging to a specific user.
 *
 * @param userId - The user's unique identifier.
 * @returns A promise that resolves to an array of `ChildSummary` objects,
 *   ordered by most-recent record date descending.
 */
export async function listChildren(userId: string): Promise<ChildSummary[]> {
  await ensureDir(userId);
  const dir = userDir(userId);
  const files = await fs.readdir(dir);
  const children: ChildSummary[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const child = JSON.parse(
        await fs.readFile(path.join(dir, file), 'utf-8')
      ) as Child;
      const records = child.records || [];
      children.push({
        childId: child.childId,
        name: child.name,
        birthDate: child.birthDate,
        gender: child.gender,
        recordCount: records.length,
        lastRecordDate: records.length > 0
          ? records.reduce(
              (latest, r) => r.date > latest ? r.date : latest,
              records[0].date,
            )
          : undefined,
      });
    } catch {
      // Skip corrupt files silently.
    }
  }

  children.sort((a, b) => (b.lastRecordDate || '').localeCompare(a.lastRecordDate || ''));
  return children;
}

/**
 * Retrieve a single child by ID for a given user.
 */
export async function getChild(userId: string, childId: string): Promise<Child | null> {
  try {
    return await readFile(userId, childId);
  } catch {
    return null;
  }
}

/**
 * Create a new child for a given user.
 */
export async function createChild(userId: string, data: CreateChild): Promise<Child> {
  await ensureDir(userId);
  const now = new Date().toISOString();
  const child: Child = {
    childId: `c_${uuidv4().slice(0, 8)}`,
    name: data.name,
    birthDate: data.birthDate,
    gender: data.gender,
    records: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(userId, child);
  return child;
}

/**
 * Update a child's mutable fields for a given user.
 */
export async function updateChild(userId: string, childId: string, data: UpdateChild): Promise<Child | null> {
  const child = await getChild(userId, childId);
  if (!child) return null;

  if (data.name !== undefined) child.name = data.name;
  if (data.birthDate !== undefined) child.birthDate = data.birthDate;
  if (data.gender !== undefined) child.gender = data.gender;

  await writeFile(userId, child);
  return child;
}

/**
 * Delete a child and all of its growth records for a given user.
 */
export async function deleteChild(userId: string, childId: string): Promise<boolean> {
  try {
    await fs.unlink(childPath(userId, childId));
    return true;
  } catch {
    return false;
  }
}

// ===================================================================
//  Growth Record CRUD
// ===================================================================

/**
 * Append a new growth record to a child's record list.
 */
export async function addRecord(
  userId: string,
  childId: string,
  data: CreateGrowthRecord,
): Promise<GrowthRecord | null> {
  const child = await getChild(userId, childId);
  if (!child) return null;

  const record: GrowthRecord = {
    id: `rec_${uuidv4().slice(0, 8)}`,
    ...data,
    createdAt: new Date().toISOString(),
  };

  child.records.push(record);
  await writeFile(userId, child);
  return record;
}

/**
 * Update an existing growth record in-place for a given user.
 */
export async function updateRecord(
  userId: string,
  childId: string,
  recordId: string,
  data: UpdateGrowthRecord,
): Promise<GrowthRecord | null> {
  const child = await getChild(userId, childId);
  if (!child) return null;

  const index = child.records.findIndex((r) => r.id === recordId);
  if (index === -1) return null;

  child.records[index] = {
    ...child.records[index],
    ...data,
    id: recordId,
    createdAt: child.records[index].createdAt,
  };

  await writeFile(userId, child);
  return child.records[index];
}

/**
 * Remove a growth record from a child's record list for a given user.
 */
export async function deleteRecord(
  userId: string,
  childId: string,
  recordId: string,
): Promise<boolean> {
  const child = await getChild(userId, childId);
  if (!child) return false;

  const index = child.records.findIndex((r) => r.id === recordId);
  if (index === -1) return false;

  child.records.splice(index, 1);
  await writeFile(userId, child);
  return true;
}
