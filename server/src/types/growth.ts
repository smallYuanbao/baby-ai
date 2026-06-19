/**
 * Growth Module — Domain Types & Validation Schemas
 *
 * This file defines the core data contracts for the baby growth tracking module.
 * It serves as the single source of truth for shape and validation rules consumed
 * by controllers, services, and the database layer.
 *
 * Architecture role:
 * - **Validation boundary**: Zod schemas enforce structural and semantic rules at
 *   the API entry point before data reaches business logic or persistence.
 * - **Type derivation**: All "Create" / "Update" TypeScript types are inferred from
 *   their Zod schemas via `z.infer`, guaranteeing that runtime validation and
 *   compile-time type-checking stay in lockstep.
 * - **Read-model interfaces**: `GrowthRecord`, `Child`, and `ChildSummary` describe
 *   the shapes returned by the database / service layer — they carry enriched data
 *   (generated IDs, timestamps) that the input schemas do not include.
 *
 * Conventions:
 * - Input DTOs (Create / Update variants) are **Zod-inferred** — they never drift from the
 *   validation rules.
 * - Output / persisted models are **explicit TypeScript interfaces** — they contain
 *   server-generated fields (id, childId, createdAt, updatedAt) that clients
 *   must not supply.
 * - All date strings use the `YYYY-MM-DD` format (ISO 8601 date-only).
 */

import { z } from 'zod';

/* ====================================================================
   Zod Validation Schemas
   These define the runtime validation contracts for incoming API payloads.
   Every constraint (min, max, regex) mirrors domain invariants.
   ==================================================================== */

/**
 * Feeding — describes a single feeding event recorded inside a growth record.
 *
 * Represents what and how much the baby consumed during a feeding session.
 * The `amount` field is optional to accommodate "on-demand" breastfeeding
 * where a precise measurement is not always available.
 */
export const FeedingSchema = z.object({
  /** Feeding method. `breast` = breastmilk, `formula` = prepared formula, `solid` = solid food, `mixed` = combination */
  type: z.enum(['breast', 'formula', 'solid', 'mixed']),

  /**
   * Quantity consumed. Omitted when the amount could not be measured
   * (e.g. on-demand nursing).
   */
  amount: z.number().positive().optional(),

  /**
   * Unit of measurement for the amount.
   * - `ml` / `oz` — liquids (breastmilk, formula)
   * - `g` — solids and semi-solids
   * - `次` — counting-based measure ("times"), used when volume/weight is impractical
   */
  unit: z.enum(['ml', 'oz', 'g', '次']).optional(),

  /**
   * Free-text notes about this feeding (e.g. "refused solids", "allergic reaction to egg").
   * Capped at 200 characters to prevent abuse of free-text fields.
   */
  notes: z.string().max(200).optional(),
});

/**
 * CreateGrowthRecord — input DTO for recording a new growth measurement.
 *
 * Every field except `date` is optional: a caregiver may record only the data points
 * they have at hand (e.g. weight-only visit to the paediatrician).
 *
 * Validation bounds reflect WHO child growth standards for children 0–5 years:
 * - Height: 30–180 cm (covers preemie to tall 5-year-old)
 * - Weight: 1–100 kg (covers low-birthweight to obese 5-year-old)
 * - Head circumference: 20–80 cm (microcephaly → macrocephaly range)
 * - Sleep: 0–24 hours (full-day cap; sum of naps + night sleep)
 * - Diapers: 0–50 per day (high-end accommodates newborn frequency)
 */
export const CreateGrowthRecordSchema = z.object({
  /** Measurement date in YYYY-MM-DD format (ISO 8601 date-only). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式: YYYY-MM-DD'),

  /** Height in cm. WHO range: 30 cm (extreme preemie) to 180 cm (tall 5-year-old). */
  height: z.number().min(30).max(180).optional(),

  /** Weight in kg. Acceptable range: 1 kg (low birthweight) to 100 kg (extreme upper bound). */
  weight: z.number().min(1).max(100).optional(),

  /** Head circumference in cm. Clinical range: 20 cm (microcephaly) to 80 cm (macrocephaly). */
  headCircumference: z.number().min(20).max(80).optional(),

  /** Total sleep duration in hours (aggregate of naps + night sleep). Capped at 24h. */
  sleepDuration: z.number().min(0).max(24).optional(),

  /** Feeding details for this record. See {@link FeedingSchema}. */
  feeding: FeedingSchema.optional(),

  /** Number of diaper changes. 0–50 range accommodates newborn frequency (up to ~12/day). */
  diapers: z.number().int().min(0).max(50).optional(),

  /** Free-text caregiver notes. Capped at 500 characters. */
  notes: z.string().max(500).optional(),
});

/**
 * UpdateGrowthRecord — partial-update DTO for modifying an existing growth record.
 *
 * Derived from `CreateGrowthRecordSchema.partial()` — every field, including `date`,
 * becomes optional so callers can send only the fields they want to change (PATCH semantics).
 */
export const UpdateGrowthRecordSchema = CreateGrowthRecordSchema.partial();

/**
 * CreateChild — input DTO for registering a new baby/child profile.
 *
 * The `birthDate` is required at creation time because it anchors all age-based
 * percentile calculations (WHO growth charts compare measurements to exact age in months).
 */
export const CreateChildSchema = z.object({
  /** Display name for the child (1–50 characters). */
  name: z.string().min(1).max(50),

  /** Date of birth in YYYY-MM-DD format. Drives age-at-measurement calculations for percentile lookups. */
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式: YYYY-MM-DD'),

  /** Biological sex — used to select the correct WHO reference population (male/female growth charts differ). */
  gender: z.enum(['male', 'female']),
});

/**
 * UpdateChild — partial-update DTO for modifying a child profile.
 *
 * Derived from `CreateChildSchema.partial()`. All fields optional (PATCH semantics).
 */
export const UpdateChildSchema = CreateChildSchema.partial();

/* ====================================================================
   TypeScript Types (inferred from Zod schemas)
   These are the compile-time companions to the runtime validation above.
   ==================================================================== */

/** Shape of a single feeding event. Inferred from {@link FeedingSchema}. */
export type Feeding = z.infer<typeof FeedingSchema>;

/** Shape of the request body for `POST /growth-records`. Inferred from {@link CreateGrowthRecordSchema}. */
export type CreateGrowthRecord = z.infer<typeof CreateGrowthRecordSchema>;

/** Shape of the request body for `PATCH /growth-records/:id`. Every field is optional. Inferred from {@link UpdateGrowthRecordSchema}. */
export type UpdateGrowthRecord = z.infer<typeof UpdateGrowthRecordSchema>;

/** Shape of the request body for `POST /children`. Inferred from {@link CreateChildSchema}. */
export type CreateChild = z.infer<typeof CreateChildSchema>;

/** Shape of the request body for `PATCH /children/:childId`. Every field is optional. Inferred from {@link UpdateChildSchema}. */
export type UpdateChild = z.infer<typeof UpdateChildSchema>;

/* ====================================================================
   Read-Model Interfaces (output / persisted shapes)
   These are the shapes returned by the service layer and stored in the database.
   They include server-generated fields that input DTOs intentionally exclude.
   ==================================================================== */

/**
 * GrowthRecord — the persisted representation of a single growth measurement.
 *
 * Returned by:
 * - `GET /children/:childId/records`
 * - `GET /children/:childId/records/:id`
 * - As elements inside `Child.records[]`
 *
 * Differs from `CreateGrowthRecord` by adding server-assigned `id` and `createdAt`.
 */
export interface GrowthRecord {
  /** Unique identifier assigned by the persistence layer on creation. */
  id: string;

  /** Measurement date in YYYY-MM-DD format. */
  date: string;

  /** Height in cm. Absent when not measured at this visit. */
  height?: number;

  /** Weight in kg. Absent when not measured at this visit. */
  weight?: number;

  /** Head circumference in cm. Absent when not measured at this visit. */
  headCircumference?: number;

  /** Total sleep in hours. Absent when not tracked for this record. */
  sleepDuration?: number;

  /** Feeding details. Absent when feeding was not recorded. */
  feeding?: Feeding;

  /** Number of diaper changes. Absent when not tracked. */
  diapers?: number;

  /** Free-text caregiver notes. Absent when no notes were provided. */
  notes?: string;

  /** ISO 8601 timestamp of when this record was first persisted. */
  createdAt: string;
}

/**
 * Child — the full representation of a child profile including all growth records.
 *
 * Returned by:
 * - `GET /children/:childId`
 * - `POST /children` (the created child, with empty `records` initially)
 *
 * This is the "fat" read model — `records` is populated eagerly.
 * For list endpoints that must avoid loading full record histories,
 * use {@link ChildSummary} instead.
 */
export interface Child {
  /** Unique identifier assigned by the persistence layer on creation. */
  childId: string;

  /** Display name for the child. */
  name: string;

  /** Date of birth in YYYY-MM-DD format. */
  birthDate: string;

  /** Biological sex — drives WHO percentile chart selection. */
  gender: 'male' | 'female';

  /** All growth records associated with this child, ordered by date descending (most recent first). */
  records: GrowthRecord[];

  /** ISO 8601 timestamp of when this child profile was first persisted. */
  createdAt: string;

  /** ISO 8601 timestamp of the last update to this child profile. */
  updatedAt: string;
}

/**
 * ChildSummary — a lightweight projection of a child profile for list views.
 *
 * Returned by:
 * - `GET /children` (list all children)
 *
 * Omits the full `records` array to keep list responses small. Includes
 * `recordCount` and `lastRecordDate` so the UI can show at-a-glance stats
 * without fetching every record.
 */
export interface ChildSummary {
  /** Unique identifier of the child. */
  childId: string;

  /** Display name. */
  name: string;

  /** Date of birth in YYYY-MM-DD format. */
  birthDate: string;

  /** Biological sex. */
  gender: 'male' | 'female';

  /** Total number of growth records for this child. Used to display "12 records" badges in the UI. */
  recordCount: number;

  /** Date of the most recent growth record, or `undefined` if no records exist yet. Used for "last updated N days ago" display. */
  lastRecordDate?: string;
}
