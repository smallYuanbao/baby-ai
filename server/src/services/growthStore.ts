/**
 * Growth Store Service
 * ====================
 *
 * **Responsibility:** File-based persistence layer for child growth-tracking data.
 * Each child is stored as an independent JSON file under `server/data/growth/`,
 * with all of that child's growth records embedded inline.
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
 *   c_a1b2c3d4.json   ← { childId, name, birthDate, gender, records[], … }
 *   c_e5f6g7h8.json
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

/** Absolute path to the directory that holds all child JSON files. */
const DATA_DIR = path.resolve('server/data/growth');

/**
 * Derive the on-disk file path for a given child.
 *
 * @param childId - The child's unique identifier (e.g. `"c_a1b2c3d4"`).
 * @returns Absolute path to `<DATA_DIR>/<childId>.json`.
 *
 * @internal Not exported — path derivation is a private concern of this module.
 */
function childPath(childId: string): string {
  return path.join(DATA_DIR, `${childId}.json`);
}

/**
 * Ensure the data directory exists, creating it (and any missing ancestors)
 * if necessary. Safe to call before every write — it is a no-op when the
 * directory already exists.
 *
 * @throws {Error} When the filesystem rejects the `mkdir` call (permissions,
 *   path is an existing *file*, etc.).
 *
 * @internal
 */
async function ensureDir(): Promise<void> {
  // `recursive: true` is idempotent — it won't error if the directory exists.
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Read and parse a child's JSON file from disk.
 *
 * **Pre-condition:** the caller must have already verified (or be prepared to
 * catch) that the file exists. A missing file results in a thrown `ENOENT`
 * error.
 *
 * @param childId - The child's unique identifier.
 * @returns The fully-hydrated `Child` object, including all growth records.
 *
 * @throws {Error} When the file does not exist (`ENOENT`).
 * @throws {SyntaxError} When the file content is not valid JSON.
 *
 * @internal
 */
async function readFile(childId: string): Promise<Child> {
  const raw = await fs.readFile(childPath(childId), 'utf-8');
  return JSON.parse(raw) as Child;
}

/**
 * Serialize a `Child` object to its JSON file on disk.
 *
 * **Side-effects:**
 * 1. Calls `ensureDir()` so the write will not fail because of a missing
 *    parent directory.
 * 2. Touches `updatedAt` to the current timestamp **every time** a child is
 *    persisted, regardless of whether the caller modified other fields.
 *
 * @param child - The child object to persist. Its `updatedAt` field will be
 *   overwritten with the current ISO timestamp.
 *
 * @internal
 */
async function writeFile(child: Child): Promise<void> {
  // Ensure the target directory tree exists before writing.
  await ensureDir();
  // Always bump the modification timestamp so consumers have a reliable
  // "last-changed" signal.
  child.updatedAt = new Date().toISOString();
  // Pretty-print with 2-space indentation so the files are human-readable
  // during development / debugging.
  await fs.writeFile(childPath(child.childId), JSON.stringify(child, null, 2), 'utf-8');
}

// ===================================================================
//  Child CRUD
// ===================================================================

/**
 * List all children in the store with a lightweight summary for each.
 *
 * **Algorithm:**
 * 1. Ensure the data directory exists (returns empty list for a fresh
 *    deployment with no children yet).
 * 2. Read every `.json` file in the directory.
 * 3. For each file, extract summary fields: `childId`, `name`, `birthDate`,
 *    `gender`, `recordCount`, and `lastRecordDate` (the most recent record
 *    date, or `undefined` if the child has no records).
 * 4. Corrupt/unparseable files are silently skipped so one bad file cannot
 *    break the entire listing.
 * 5. Results are sorted by `lastRecordDate` **descending** (most recently
 *    active children first). Children without any records sort last.
 *
 * @returns A promise that resolves to an array of `ChildSummary` objects,
 *   ordered by most-recent record date descending. Returns `[]` when no
 *   children exist.
 *
 * @throws {Error} Only on catastrophic filesystem errors (e.g. `readdir`
 *   fails because the process lacks permissions on the parent directory).
 *   Missing or corrupt individual files do NOT throw.
 */
export async function listChildren(): Promise<ChildSummary[]> {
  // Ensure the data directory exists so `readdir` does not throw ENOENT on
  // a fresh deployment.
  await ensureDir();
  const files = await fs.readdir(DATA_DIR);
  const children: ChildSummary[] = [];

  for (const file of files) {
    // Only process JSON files; ignore dotfiles, temp files, etc.
    if (!file.endsWith('.json')) continue;
    try {
      const child = JSON.parse(
        await fs.readFile(path.join(DATA_DIR, file), 'utf-8')
      ) as Child;
      const records = child.records || [];
      children.push({
        childId: child.childId,
        name: child.name,
        birthDate: child.birthDate,
        gender: child.gender,
        recordCount: records.length,
        // Find the latest record date via reduce over all records.
        // If records is empty, lastRecordDate is undefined.
        lastRecordDate: records.length > 0
          ? records.reduce(
              (latest, r) => r.date > latest ? r.date : latest,
              records[0].date,
            )
          : undefined,
      });
    } catch {
      // Degradation: skip corrupt or unparseable files so the rest of the
      // listing still succeeds. A server-side log would be appropriate here
      // in production.
    }
  }

  // Sort by lastRecordDate descending so the most recently tracked children
  // appear at the top of the list. Children with no records (undefined) sort
  // last because `localeCompare` coerces undefined to the string "undefined",
  // which compares less than any date string.
  children.sort((a, b) => (b.lastRecordDate || '').localeCompare(a.lastRecordDate || ''));
  return children;
}

/**
 * Retrieve a single child by ID, including all growth records.
 *
 * @param childId - The child's unique identifier.
 * @returns The `Child` object if found, or `null` if no file exists for that ID.
 *
 * @throws {SyntaxError} If the file exists but contains invalid JSON (should
 *   not happen in normal operation; indicates data corruption).
 */
export async function getChild(childId: string): Promise<Child | null> {
  try {
    return await readFile(childId);
  } catch {
    // `readFile` throws ENOENT when the file does not exist. All other errors
    // (permissions, etc.) are also collapsed to `null` so callers can treat
    // any failure as "not found". This is a pragmatic choice for a prototype;
    // production would distinguish "not found" from "error".
    return null;
  }
}

/**
 * Create a new child with no records.
 *
 * **Side-effects:** Persists a new JSON file to disk.
 *
 * @param data - The child's name, birth date, and gender (validated upstream
 *   by Zod via `CreateChildSchema`).
 * @returns The newly created `Child` object, including a generated `childId`
 *   (prefixed `c_`), empty `records` array, and `createdAt`/`updatedAt`
 *   timestamps.
 *
 * @throws {Error} On filesystem write failure (disk full, permission denied).
 */
export async function createChild(data: CreateChild): Promise<Child> {
  // Ensure the data directory exists before writing the new child file.
  await ensureDir();
  const now = new Date().toISOString();
  const child: Child = {
    // ID format: `c_` prefix + first 8 chars of a UUID v4.
    // Collision risk is negligible for the scale of this application.
    childId: `c_${uuidv4().slice(0, 8)}`,
    name: data.name,
    birthDate: data.birthDate,
    gender: data.gender,
    records: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(child);
  return child;
}

/**
 * Update a child's mutable fields (name, birthDate, gender).
 *
 * This is a **partial update**: only the fields present in `data` are
 * changed; omitted fields retain their existing values.
 *
 * @param childId - The child's unique identifier.
 * @param data - An object with any subset of `name`, `birthDate`, `gender`.
 *   Passed through Zod `UpdateChildSchema` (`.partial()`) upstream.
 * @returns The updated `Child` object, or `null` if no child with that ID
 *   exists.
 *
 * @throws {Error} On filesystem write failure.
 */
export async function updateChild(childId: string, data: UpdateChild): Promise<Child | null> {
  // Fetch the existing child; return null early if not found.
  const child = await getChild(childId);
  if (!child) return null;

  // Apply only the provided fields (undefined fields are left unchanged).
  if (data.name !== undefined) child.name = data.name;
  if (data.birthDate !== undefined) child.birthDate = data.birthDate;
  if (data.gender !== undefined) child.gender = data.gender;

  await writeFile(child);
  return child;
}

/**
 * Delete a child and all of its growth records.
 *
 * **Destructive:** The JSON file is permanently removed from disk. Growth
 * records are not archived or soft-deleted.
 *
 * @param childId - The child's unique identifier.
 * @returns `true` if the file was deleted, `false` if no file existed for
 *   that ID.
 *
 * @throws {Error} Only on unexpected filesystem errors other than ENOENT
 *   (e.g. permission denied on the directory, though this is unusual for
 *   `unlink`).
 */
export async function deleteChild(childId: string): Promise<boolean> {
  try {
    await fs.unlink(childPath(childId));
    return true;
  } catch {
    // ENOENT (file not found) is the expected "already deleted" case.
    // Other errors (permissions, etc.) are also collapsed to `false` —
    // a production version would log and potentially re-throw them.
    return false;
  }
}

// ===================================================================
//  Growth Record CRUD
// ===================================================================

/**
 * Append a new growth record to a child's record list.
 *
 * **Data-flow contract:**
 * ```
 * Route handler                         This function
 * ─────────────                         ─────────────
 * CreateGrowthRecord (Zod-validated) ──► data: CreateGrowthRecord
 *                                       │
 *                                       ├─ getChild(childId)  → Child | null
 *                                       ├─ uuidv4()           → record.id
 *                                       ├─ child.records.push(record)
 *                                       └─ writeFile(child)   → persisted
 *                                       return GrowthRecord | null
 * ```
 *
 * @param childId - The child's unique identifier.
 * @param data - The record fields (date, and optionally height, weight, etc.).
 *   Validated upstream by `CreateGrowthRecordSchema`.
 * @returns The newly created `GrowthRecord` (with generated `id` and
 *   `createdAt`), or `null` if the child does not exist.
 *
 * @throws {Error} On filesystem write failure.
 */
export async function addRecord(
  childId: string,
  data: CreateGrowthRecord,
): Promise<GrowthRecord | null> {
  // Guard: child must exist before we can add a record for them.
  const child = await getChild(childId);
  if (!child) return null;

  const record: GrowthRecord = {
    // ID format: `rec_` prefix + first 8 chars of a UUID v4.
    id: `rec_${uuidv4().slice(0, 8)}`,
    // Spread the validated input fields (date, height?, weight?, …).
    ...data,
    createdAt: new Date().toISOString(),
  };

  // Append the new record in chronological insertion order.
  // Note: records are NOT sorted by date here — they simply accumulate.
  // The front-end / report layer is responsible for sorting as needed.
  child.records.push(record);
  await writeFile(child);
  return record;
}

/**
 * Update an existing growth record in-place.
 *
 * **Merge strategy:** The existing record is shallow-merged with the provided
 * `data`. Fields present in `data` overwrite the originals; fields omitted
 * from `data` are preserved. The record's `id` and `createdAt` are immutable
 * and are restored from the existing record after the merge.
 *
 * **Data-flow contract:**
 * ```
 * Route handler                          This function
 * ─────────────                          ─────────────
 * UpdateGrowthRecord (Zod-validated) ───► data: UpdateGrowthRecord
 *                                        │
 *                                        ├─ getChild(childId)           → Child | null
 *                                        ├─ records.findIndex(recordId) → index | -1
 *                                        ├─ spread merge + id/createdAt guard
 *                                        └─ writeFile(child)            → persisted
 *                                        return GrowthRecord | null
 * ```
 *
 * @param childId - The child's unique identifier.
 * @param recordId - The record's unique identifier (e.g. `"rec_a1b2c3d4"`).
 * @param data - Partial record fields to update. Validated upstream by
 *   `UpdateGrowthRecordSchema`.
 * @returns The updated `GrowthRecord`, or `null` if either the child or the
 *   record does not exist.
 *
 * @throws {Error} On filesystem write failure.
 */
export async function updateRecord(
  childId: string,
  recordId: string,
  data: UpdateGrowthRecord,
): Promise<GrowthRecord | null> {
  // Guard: child must exist.
  const child = await getChild(childId);
  if (!child) return null;

  // Linear search for the target record by ID. Acceptable because a single
  // child is unlikely to have more than a few hundred records.
  const index = child.records.findIndex((r) => r.id === recordId);
  if (index === -1) return null;

  // Shallow-merge the update data over the existing record, then forcibly
  // restore the immutable fields (`id`, `createdAt`) so they cannot be
  // accidentally overwritten by the spread.
  child.records[index] = {
    ...child.records[index],
    ...data,
    id: recordId,                              // Immutable — restore from param.
    createdAt: child.records[index].createdAt, // Immutable — restore from original.
  };

  await writeFile(child);
  return child.records[index];
}

/**
 * Remove a growth record from a child's record list.
 *
 * @param childId - The child's unique identifier.
 * @param recordId - The record's unique identifier.
 * @returns `true` if the record was found and removed, `false` if the child
 *   or the record does not exist.
 *
 * @throws {Error} On filesystem write failure.
 */
export async function deleteRecord(
  childId: string,
  recordId: string,
): Promise<boolean> {
  // Guard: child must exist.
  const child = await getChild(childId);
  if (!child) return false;

  // Linear search for the target record.
  const index = child.records.findIndex((r) => r.id === recordId);
  if (index === -1) return false;

  // Remove the record in-place via splice.
  child.records.splice(index, 1);
  await writeFile(child);
  return true;
}
