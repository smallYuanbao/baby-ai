/**
 * @fileoverview Type definitions for the baby growth tracking module.
 *
 * This file defines the core data models used throughout the growth-tracking
 * feature: individual feeding records, growth measurements (height, weight,
 * head circumference, sleep), per-child record collections, summary views
 * for list UIs, chart-ready data points, and AI-generated analysis results.
 *
 * All date/time fields use ISO-8601 strings. Numeric values follow metric
 * conventions (cm, kg, ml, g) with optional imperial alternatives (oz).
 */

/**
 * Describes a single feeding session for a child.
 *
 * Supports breast, formula, solid, and mixed feeding types. The optional
 * `amount` and `unit` pair records quantitative intake when available
 * (e.g. "120 ml" of formula), while `notes` captures free-text details
 * like food type or feeding difficulties.
 */
export interface Feeding {
  /** Feeding method used for this session. */
  type: 'breast' | 'formula' | 'solid' | 'mixed';

  /** Quantity consumed. Omitted when amount is not tracked (e.g. on-demand breastfeeding). */
  amount?: number;

  /** Unit for {@link amount}. Chinese "次" (times) is used when only count matters, not volume/weight. */
  unit?: 'ml' | 'oz' | 'g' | '次';

  /** Free-text notes about this feeding (food type, allergies, difficulties, etc.). */
  notes?: string;
}

/**
 * A single growth record capturing measurements and daily-care events for one date.
 *
 * All measurement fields are optional — a record may track only weight, only
 * feeding, or any combination. This flexibility accommodates real-world usage
 * where parents log what they can.
 */
export interface GrowthRecord {
  /** Unique identifier for this record (UUID or server-generated). */
  id: string;

  /** ISO-8601 date string (YYYY-MM-DD) for which this record applies. */
  date: string;

  /** Height in centimetres. */
  height?: number;

  /** Weight in kilograms. */
  weight?: number;

  /** Head circumference in centimetres. */
  headCircumference?: number;

  /** Total sleep duration in hours (decimal, e.g. 1.5 = 1h 30m). */
  sleepDuration?: number;

  /** Feeding details for the day. Omitted when no feeding was logged. */
  feeding?: Feeding;

  /** Number of diaper changes logged for the day. */
  diapers?: number;

  /** Free-text notes for any additional observations. */
  notes?: string;

  /** ISO-8601 timestamp of when this record was first persisted. */
  createdAt: string;
}

/**
 * A child entity with its full growth history.
 *
 * This is the primary domain object for the growth module. It embeds all
 * {@link GrowthRecord} entries inline so the full timeline travels in a
 * single payload — convenient for offline-capable UIs and charting.
 */
export interface Child {
  /** Server-assigned unique identifier for this child. */
  childId: string;

  /** Display name. */
  name: string;

  /** ISO-8601 date string (YYYY-MM-DD) for the child's date of birth. */
  birthDate: string;

  /** Biological sex, used for selecting the appropriate growth-percentile curves. */
  gender: 'male' | 'female';

  /** Chronological list of growth records (oldest first). */
  records: GrowthRecord[];

  /** ISO-8601 timestamp of initial creation. */
  createdAt: string;

  /** ISO-8601 timestamp of the most recent update. */
  updatedAt: string;
}

/**
 * A lightweight view of a child for list and card UIs.
 *
 * Differs from {@link Child} by omitting the full `records` array and instead
 * surfacing a count and the most recent record date. This avoids pulling the
 * entire growth history when only a summary is needed (e.g. the child-selection
 * screen).
 */
export interface ChildSummary {
  /** Server-assigned unique identifier for this child. */
  childId: string;

  /** Display name. */
  name: string;

  /** ISO-8601 date string (YYYY-MM-DD) for the child's date of birth. */
  birthDate: string;

  /** Biological sex. */
  gender: 'male' | 'female';

  /** Total number of growth records associated with this child. */
  recordCount: number;

  /** ISO-8601 date string for the most recent record, or undefined if no records exist yet. */
  lastRecordDate?: string;
}

/**
 * A single data point on a growth chart.
 *
 * The `ageMonths` field drives the x-axis and enables percentile-curve
 * comparisons (WHO/CDC standards are keyed by age in months). The `date`
 * field is preserved for tooltip display and is NOT used for chart positioning.
 */
export interface ChartDataPoint {
  /** Child's age in decimal months at the time of measurement (e.g. 3.5 = 3 months 15 days). */
  ageMonths: number;

  /** ISO-8601 date string for this measurement (tooltip display only). */
  date: string;

  /** The measured value — unit depends on the chart metric (kg, cm, or cm). */
  value: number;
}

/**
 * A server response containing chart-ready data for a single metric and child.
 *
 * Each response covers exactly one metric (weight, height, or head
 * circumference), so a dashboard with three charts will issue three requests.
 */
export interface ChartDataResponse {
  /** The metric this response covers. */
  metric: 'weight' | 'height' | 'headCircumference';

  /** Identifier of the child these data points belong to. */
  childId: string;

  /** Display name of the child (avoids a separate lookup). */
  childName: string;

  /** Chronological list of data points (oldest first). */
  dataPoints: ChartDataPoint[];
}

/**
 * AI-generated analysis of a child's growth patterns.
 *
 * Produced server-side by an LLM that reviews the growth history against
 * standard percentile curves. The `suggestions` list offers actionable
 * parenting tips while `warnings` flags measurements that fall significantly
 * outside expected ranges.
 */
export interface GrowthAnalysisResult {
  /** The child this analysis applies to. */
  childId: string;

  /** ISO-8601 timestamp of when the analysis was generated. */
  generatedAt: string;

  /** Human-readable summary paragraph describing the overall growth trend. */
  summary: string;

  /** Actionable recommendations (e.g. "Increase solid food frequency to 3x/day"). */
  suggestions: string[];

  /** Concerns that may warrant professional attention (e.g. "Weight below 3rd percentile"). */
  warnings: string[];
}
