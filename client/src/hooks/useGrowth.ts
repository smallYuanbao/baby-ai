/**
 * @file useGrowth.ts
 * @description Custom React hook that centralizes all growth-tracking state and API orchestration.
 *
 * ## Responsibility
 * This hook is the single source of truth for the Growth screen. It owns:
 * - The list of all children (summaries) for the family
 * - The currently selected child's full detail (including growth records)
 * - Shared loading / error UI state
 *
 * ## Data Flow
 * Components (e.g. GrowthDashboard, ChildForm, RecordEditor) import this hook to
 * read state (`children`, `selectedChild`, `loading`, `error`) and to dispatch
 * mutations (`createChild`, `addRecord`, …). Mutations always:
 * 1. Call the API through the `api.growth` service layer
 * 2. Re-fetch affected server state so the local cache stays consistent
 * 3. Re-throw errors so callers can surface inline validation messages
 *
 * ## Edge Cases & Conventions
 * - `getChartData` is read-only and does **not** touch `loading` / `error` state.
 *   Chart components manage their own loading indicators.
 * - `createChild` and `addRecord` re-throw after setting global `error` so the
 *   calling form can both display the global banner AND highlight the specific field.
 * - Deleting the currently-selected child clears `selectedChild` to avoid a stale
 *   detail view pointing at a non-existent resource.
 * - The initial `useEffect` fires once on mount and refreshes the child list.
 * - `loadChildren` is intentionally not called after `addRecord`/`updateRecord`/
 *   `deleteRecord` — only `loadChild` is refreshed so the full detail stays in sync.
 *   The list of children (names, ages) rarely changes during record editing.
 */

import { useState, useCallback, useEffect } from 'react';
import { api } from '../services/api';
import type { Child, ChildSummary, GrowthRecord, ChartDataResponse } from '../types/growth';

/**
 * Growth data-management hook.
 *
 * Provides all state and actions needed by the Growth feature: child CRUD,
 * growth-record CRUD, chart-data retrieval, and shared loading/error UI state.
 *
 * @returns An object with the following properties:
 *
 *   **State**
 *   - `children: ChildSummary[]` — Lightweight list of all children for the
 *     current account. Used by the child-picker sidebar and dashboard cards.
 *   - `selectedChild: Child | null` — Full detail (profile + records) for the
 *     currently focused child. `null` when no child is selected or after the
 *     selected child is deleted.
 *   - `loading: boolean` — True while **any** mutation or detail fetch is in
 *     flight. Note: `getChartData` does NOT flip this flag (chart loading is
 *     handled locally by chart components).
 *   - `error: string | null` — The most recent user-facing error message, or
 *     `null` when no error is present.
 *
 *   **Children CRUD**
 *   - `loadChildren: () => Promise<void>` — (Re-)fetch the full child list.
 *     Called automatically on mount.
 *   - `loadChild: (childId: string) => Promise<void>` — Fetch full detail for
 *     one child, replacing `selectedChild`. Sets `loading` while in flight.
 *   - `createChild: (data) => Promise<Child>` — Create a child profile, then
 *     re-fetch the list so the picker stays up-to-date. **Re-throws** on failure
 *     so the calling form can handle field-level validation.
 *   - `deleteChild: (childId: string) => Promise<void>` — Delete a child. If the
 *     deleted child is `selectedChild`, that reference is set to `null` to
 *     prevent rendering a stale detail panel.
 *
 *   **Growth-Record CRUD**
 *   - `addRecord: (childId, data) => Promise<GrowthRecord>` — Add a record
 *     (height, weight, head circumference, etc.), then refresh the selected
 *     child's detail. **Re-throws** on failure for inline form handling.
 *   - `updateRecord: (childId, recordId, data) => Promise<GrowthRecord>` —
 *     Update an existing record, then refresh the selected child's detail.
 *     **Re-throws** on failure.
 *   - `deleteRecord: (childId, recordId) => Promise<void>` — Delete a record,
 *     then refresh the selected child's detail.
 *
 *   **Chart Data**
 *   - `getChartData: (childId, metric) => Promise<ChartDataResponse>` — Fetch
 *     time-series data for a specific metric (height/weight/etc.) without
 *     altering shared loading/error state. Chart components call this directly
 *     and manage their own spinners.
 *
 *   **Utility**
 *   - `setError: (message: string | null) => void` — Imperatively clear or set
 *     the global error. Useful for dismissing error banners on user interaction.
 */
export function useGrowth() {
  // ---- State (owned by this hook, shared across the Growth feature) ----

  /** Lightweight list of all children; used in picker UIs. */
  const [children, setChildren] = useState<ChildSummary[]>([]);

  /**
   * Full detail for the currently selected child, including their growth
   * records. `null` means no child is currently in focus (or the previously
   * focused child was deleted).
   */
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);

  /**
   * Global loading flag. `true` while any data-fetching mutation is pending.
   * Callers should disable form submit buttons and show spinners when this
   * is true.  Read-only operations like `getChartData` do **not** set this
   * flag so that chart interactions don't flash global spinners.
   */
  const [loading, setLoading] = useState(false);

  /**
   * The most recent user-facing error message. Set to `null` at the start of
   * every operation so that error banners are cleared on retry.  Callers can
   * also imperatively clear it via the returned `setError` helper.
   */
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------
  //  Children CRUD
  // ---------------------------------------------------------------

  /**
   * Fetch the list of all children for the current account.
   *
   * Sets `loading` to true during the fetch and clears `error` on retry.
   * Called automatically when the hook mounts (see `useEffect` below).
   *
   * @returns A promise that resolves when the child list has been stored in state.
   */
  const loadChildren = useCallback(async () => {
    try {
      setLoading(true);
      // Clear any previous error so the banner disappears on retry.
      setError(null);
      const list = await api.growth.listChildren();
      setChildren(list);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Side-effect: load the child list once on mount.
   *
   * `loadChildren` has an empty dependency array ([]), so it is stable across
   * renders and this effect fires exactly once.  There is no cleanup needed
   * because the async request is fire-and-forget — the `finally` block ensures
   * `loading` is always reset regardless of success or failure.
   */
  useEffect(() => {
    loadChildren();
  }, [loadChildren]);

  /**
   * Fetch full detail for a single child, replacing `selectedChild`.
   *
   * @param childId - The unique identifier of the child to load.
   * @returns A promise that resolves when the detail has been stored in state.
   */
  const loadChild = useCallback(async (childId: string) => {
    try {
      setLoading(true);
      const child = await api.growth.getChild(childId);
      setSelectedChild(child);
      // Clear error on success so a previous failure doesn't linger.
      setError(null);
    } catch (err: any) {
      setError(err.message || '加载宝宝信息失败');
    } finally {
      // Always release the loading flag, even on error, so UI controls
      // are re-enabled and the user can retry.
      setLoading(false);
    }
  }, []);

  /**
   * Create a new child profile, then refresh the child list.
   *
   * On success the list is re-fetched so the picker immediately shows the
   * new child without a full page reload.
   *
   * @param data - The child's profile fields: `name`, `birthDate`, `gender`.
   * @returns The newly created `Child` object from the API.
   * @throws The API error if creation fails — re-thrown so the calling form
   *         can display field-level validation errors in addition to the
   *         global error banner set here.
   */
  const createChild = useCallback(async (data: { name: string; birthDate: string; gender: string }) => {
    try {
      const child = await api.growth.createChild(data);
      // Refresh the list so the new child appears in sidebars / pickers.
      await loadChildren();
      return child;
    } catch (err: any) {
      setError(err.message || '创建失败');
      // Re-throw to let the form component handle inline validation display.
      throw err;
    }
  }, [loadChildren]);

  /**
   * Delete a child by ID, then refresh the child list.
   *
   * **Edge case:** If the deleted child is currently `selectedChild`, that
   * reference is set to `null` so the detail panel doesn't try to render
   * a now-deleted resource (which would cause a 404 on the next refresh).
   *
   * @param childId - The unique identifier of the child to delete.
   * @returns A promise that resolves when the deletion and list refresh complete.
   */
  const deleteChild = useCallback(async (childId: string) => {
    try {
      await api.growth.deleteChild(childId);
      // Guard: if the user was viewing the deleted child, clear the detail
      // view to avoid a stale pointer.
      if (selectedChild?.childId === childId) {
        setSelectedChild(null);
      }
      await loadChildren();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  }, [selectedChild, loadChildren]);

  // ---------------------------------------------------------------
  //  Growth-Record CRUD
  // ---------------------------------------------------------------

  /**
   * Add a growth record (height, weight, etc.) for a child.
   *
   * After the record is created the selected child's full detail is re-fetched
   * so that the new record appears in the timeline / chart data without the
   * caller having to manually reload.
   *
   * @param childId - The child this record belongs to.
   * @param data    - Record fields (date, height, weight, headCircumference, note).
   * @returns The newly created `GrowthRecord` from the API.
   * @throws The API error (re-thrown for inline form handling).
   */
  const addRecord = useCallback(async (childId: string, data: any) => {
    try {
      const record = await api.growth.addRecord(childId, data);
      // Refresh the selected child so the new record appears immediately in
      // the detail view's record list and the growth chart.
      await loadChild(childId);
      return record;
    } catch (err: any) {
      setError(err.message || '添加记录失败');
      // Re-throw so the calling RecordForm can highlight the offending field.
      throw err;
    }
  }, [loadChild]);

  /**
   * Update an existing growth record.
   *
   * After a successful update the selected child's detail is refreshed so
   * the UI reflects the changed values.
   *
   * @param childId  - The child this record belongs to.
   * @param recordId - The unique identifier of the record to update.
   * @param data     - Fields to update (merged with existing data by the API).
   * @returns The updated `GrowthRecord` from the API.
   * @throws The API error (re-thrown for inline form handling).
   */
  const updateRecord = useCallback(async (childId: string, recordId: string, data: any) => {
    try {
      const record = await api.growth.updateRecord(childId, recordId, data);
      // Refresh detail after mutation so charts / record lists stay current.
      await loadChild(childId);
      return record;
    } catch (err: any) {
      setError(err.message || '更新记录失败');
      throw err;
    }
  }, [loadChild]);

  /**
   * Delete a growth record, then refresh the selected child's detail.
   *
   * Unlike `deleteChild`, this does **not** need to check `selectedChild`
   * because removing a record never invalidates the parent child object.
   *
   * @param childId  - The child this record belongs to.
   * @param recordId - The unique identifier of the record to delete.
   * @returns A promise that resolves when the deletion and detail refresh complete.
   */
  const deleteRecord = useCallback(async (childId: string, recordId: string) => {
    try {
      await api.growth.deleteRecord(childId, recordId);
      // Refresh the detail so the deleted record disappears from the list.
      await loadChild(childId);
    } catch (err: any) {
      setError(err.message || '删除记录失败');
    }
  }, [loadChild]);

  // ---------------------------------------------------------------
  //  Chart Data (read-only)
  // ---------------------------------------------------------------

  /**
   * Fetch time-series chart data for a specific metric.
   *
   * This is a **read-only** operation — it does NOT touch `loading` or `error`
   * state.  Chart components are expected to call this directly and manage
   * their own loading spinners / error tooltips.
   *
   * @param childId - The child whose metric data is requested.
   * @param metric  - The growth metric (e.g. `"height"`, `"weight"`,
   *                  `"headCircumference"`).
   * @returns A promise that resolves to the chart-ready data series.
   */
  const getChartData = useCallback(async (childId: string, metric: string): Promise<ChartDataResponse> => {
    return api.growth.getChartData(childId, metric);
  }, []);

  // ---- Public API (returned to consuming components) ----
  return {
    // State
    children,
    selectedChild,
    loading,
    error,
    // Children CRUD
    loadChildren,
    loadChild,
    createChild,
    deleteChild,
    // Growth-record CRUD
    addRecord,
    updateRecord,
    deleteRecord,
    // Chart data (read-only)
    getChartData,
    // Utility
    setError,
  };
}
