/**
 * Growth Routes — Baby Growth Tracking API
 *
 * Defines HTTP endpoints for managing children's profiles, their growth records,
 * chart-ready time-series data, and an AI-powered health analysis stream (SSE).
 *
 * ## Endpoints
 *
 * ### Children (CRUD)
 * | Method | Path                           | Description                  |
 * |--------|--------------------------------|------------------------------|
 * | GET    | /children                      | List all children            |
 * | GET    | /children/:childId             | Get a single child by ID     |
 * | POST   | /children                      | Create a new child profile   |
 * | PUT    | /children/:childId             | Update a child profile       |
 * | DELETE | /children/:childId             | Delete a child and all records|
 *
 * ### Growth Records (nested CRUD)
 * | Method | Path                                    | Description              |
 * |--------|-----------------------------------------|--------------------------|
 * | POST   | /children/:childId/records              | Add a growth record      |
 * | PUT    | /children/:childId/records/:recordId    | Update an existing record|
 * | DELETE | /children/:childId/records/:recordId    | Delete a record          |
 *
 * ### Chart Data
 * | Method | Path                            | Description                         |
 * |--------|---------------------------------|-------------------------------------|
 * | GET    | /children/:childId/chart-data   | Get time-series data for charting   |
 *
 * ### AI Analysis (SSE)
 * | Method | Path                           | Description                          |
 * |--------|--------------------------------|--------------------------------------|
 * | POST   | /children/:childId/analysis    | Stream an AI-generated health report |
 *
 * ## Middleware Dependencies
 * - `validateBody` is applied on POST/PUT routes to enforce Zod schemas
 *   (CreateChildSchema, UpdateChildSchema, CreateGrowthRecordSchema,
 *    UpdateGrowthRecordSchema) before the handler runs.
 *
 * ## Error Handling
 * - 404 is returned when a child or record is not found (`NOT_FOUND` code).
 * - 400 is returned when analysis is requested with zero records (`NO_RECORDS` code).
 * - SSE endpoints stream the report token-by-token; on failure they emit an
 *   `ANALYSIS_ERROR` event over the stream before closing.
 * - Uncaught errors are forwarded to Express's `next(err)` for centralised
 *   error handling.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { validateBody } from '../middleware/validateBody.js';
import {
  CreateChildSchema,
  UpdateChildSchema,
  CreateGrowthRecordSchema,
  UpdateGrowthRecordSchema,
} from '../types/growth.js';
import * as store from '../services/growthStore.js';
import { chatStream } from '../services/deepseek.js';
import {
  initSSE,
  sendToken,
  sendDone,
  sendError,
} from '../utils/sse.js';
import logger from '../utils/logger.js';

export const growthRouter = Router();

// ===== Child CRUD =====

/**
 * GET /children
 *
 * Lists every child profile stored in the system.
 * Returns an array (possibly empty) — no pagination is applied.
 *
 * @param _req — Express Request (no params / query / body needed)
 * @param res  — Express Response
 * @returns    200 with a JSON array of Child objects
 * @error       500 via next(err) on store failure
 */
growthRouter.get('/children', async (_req, res, next) => {
  try {
    // Fetch all children from the persistence layer
    const children = await store.listChildren();
    res.json(children);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /children/:childId
 *
 * Retrieves a single child profile by its unique ID.
 *
 * @param req — Express Request with `req.params.childId` set
 * @param res — Express Response
 * @returns   200 with the Child JSON object
 * @error     404 (`NOT_FOUND`) when no child matches `childId`
 * @error     500 via next(err) on store failure
 */
growthRouter.get('/children/:childId', async (req, res, next) => {
  try {
    // Look up the child in the store by path parameter
    const child = await store.getChild(req.params.childId);
    if (!child) {
      // Not found — 404 with a human-readable error
      res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
      return;
    }
    res.json(child);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /children
 *
 * Creates a new child profile. The request body is validated against
 * `CreateChildSchema` by the `validateBody` middleware before this handler runs.
 *
 * @param req — Express Request with validated `req.body` (name, birthDate, gender)
 * @param res — Express Response
 * @returns   201 with the newly-created Child object (includes generated `childId` and timestamps)
 * @error     400 if the body fails Zod schema validation (handled by middleware)
 * @error     500 via next(err) on store failure
 */
growthRouter.post('/children', validateBody(CreateChildSchema), async (req, res, next) => {
  try {
    // Body is already validated by middleware; create the child in the store
    const child = await store.createChild(req.body);
    res.status(201).json(child);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /children/:childId
 *
 * Updates an existing child profile. The request body is validated against
 * `UpdateChildSchema` by the `validateBody` middleware before this handler runs.
 *
 * Only the fields present in the body are updated (partial / patch semantics
 * are not enforced at the route level — that is handled by the store).
 *
 * @param req — Express Request with `req.params.childId` and validated `req.body`
 * @param res — Express Response
 * @returns   200 with the updated Child object
 * @error     404 (`NOT_FOUND`) when no child matches `childId`
 * @error     400 if the body fails Zod schema validation (handled by middleware)
 * @error     500 via next(err) on store failure
 */
growthRouter.put('/children/:childId', validateBody(UpdateChildSchema), async (req, res, next) => {
  try {
    // Apply the validated partial update to the matching child
    const child = await store.updateChild(req.params.childId, req.body);
    if (!child) {
      res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
      return;
    }
    res.json(child);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /children/:childId
 *
 * Removes a child profile and all associated growth records from the store.
 * This is a destructive operation — there is no soft-delete.
 *
 * @param req — Express Request with `req.params.childId` set
 * @param res — Express Response
 * @returns   200 with `{ success: true }` on successful deletion
 * @error     404 (`NOT_FOUND`) when no child matches `childId`
 * @error     500 via next(err) on store failure
 */
growthRouter.delete('/children/:childId', async (req, res, next) => {
  try {
    // Attempt to delete; store returns false if the child didnʼt exist
    const ok = await store.deleteChild(req.params.childId);
    if (!ok) {
      res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===== Record CRUD =====

/**
 * POST /children/:childId/records
 *
 * Adds a new growth record to an existing child profile. The request body is
 * validated against `CreateGrowthRecordSchema` by the `validateBody` middleware
 * before this handler runs.
 *
 * @param req — Express Request with `req.params.childId` and validated `req.body`
 *              (date, optionally height, weight, headCircumference, sleepDuration,
 *               diapers, feeding, notes)
 * @param res — Express Response
 * @returns   201 with the newly-created Record object
 * @error     404 (`NOT_FOUND`) when the parent child does not exist
 * @error     400 if the body fails Zod schema validation (handled by middleware)
 * @error     500 via next(err) on store failure
 */
growthRouter.post(
  '/children/:childId/records',
  validateBody(CreateGrowthRecordSchema),
  async (req, res, next) => {
    try {
      // Add the record to the child identified by the URL path
      const record = await store.addRecord(req.params.childId, req.body);
      if (!record) {
        // The child referenced by childId does not exist
        res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
        return;
      }
      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /children/:childId/records/:recordId
 *
 * Updates an existing growth record. The request body is validated against
 * `UpdateGrowthRecordSchema` by the `validateBody` middleware. Both the child
 * and the specific record are identified by URL path parameters.
 *
 * @param req — Express Request with `req.params.childId`, `req.params.recordId`,
 *              and validated `req.body`
 * @param res — Express Response
 * @returns   200 with the updated Record object
 * @error     404 (`NOT_FOUND`) when either the child or the record does not exist
 * @error     400 if the body fails Zod schema validation (handled by middleware)
 * @error     500 via next(err) on store failure
 */
growthRouter.put(
  '/children/:childId/records/:recordId',
  validateBody(UpdateGrowthRecordSchema),
  async (req, res, next) => {
    try {
      // Look up the child and mutate the matching record inside it
      const record = await store.updateRecord(
        req.params.childId,
        req.params.recordId,
        req.body,
      );
      if (!record) {
        // Could be a missing child OR a missing record — the store treats both as 404
        res.status(404).json({ error: '记录不存在', code: 'NOT_FOUND' });
        return;
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /children/:childId/records/:recordId
 *
 * Removes a single growth record from a child's history.
 *
 * @param req — Express Request with `req.params.childId` and `req.params.recordId`
 * @param res — Express Response
 * @returns   200 with `{ success: true }` on successful deletion
 * @error     404 (`NOT_FOUND`) when either the child or the record does not exist
 * @error     500 via next(err) on store failure
 */
growthRouter.delete('/children/:childId/records/:recordId', async (req, res, next) => {
  try {
    // Delete the record; returns false if child or record is missing
    const ok = await store.deleteRecord(req.params.childId, req.params.recordId);
    if (!ok) {
      res.status(404).json({ error: '记录不存在', code: 'NOT_FOUND' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===== Chart Data =====

/**
 * GET /children/:childId/chart-data
 *
 * Builds a time-series dataset suitable for rendering growth charts on the
 * frontend. Each data point is keyed by the child's age in months at the time
 * of the measurement.
 *
 * Query Parameters:
 * - `metric` (optional, defaults to `"weight"`): the growth metric to extract.
 *   Common values: `"weight"`, `"height"`, `"headCircumference"`.
 *
 * Processing:
 * 1. The child's birthDate is used as the age baseline.
 * 2. Every record that has a positive numeric value for the requested metric is
 *    included.
 * 3. The record's date is converted to whole-month age (integer months since
 *    birth).
 * 4. Data points are sorted by ascending age.
 *
 * @param req — Express Request with `req.params.childId` and optional
 *              `req.query.metric` (string)
 * @param res — Express Response
 * @returns   200 with `{ metric, childId, childName, dataPoints }` where each
 *             dataPoint is `{ ageMonths, date, value }`
 * @error     404 (`NOT_FOUND`) when no child matches `childId`
 * @error     500 via next(err) on store failure
 */
growthRouter.get('/children/:childId/chart-data', async (req, res, next) => {
  try {
    // Verify the child exists before computing chart data
    const child = await store.getChild(req.params.childId);
    if (!child) {
      res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
      return;
    }

    // Parse the desired metric from query string, defaulting to weight
    const metric = (req.query.metric as string) || 'weight';

    // Baseline: the child's birth date, used to calculate age in months
    const birthDate = new Date(child.birthDate);

    // Transform raw records into (ageMonths, value) data points
    const dataPoints = child.records
      .filter((r) => {
        // Only include records that have a positive value for the requested metric
        const val = r[metric as keyof typeof r] as number | undefined;
        return val !== undefined && val > 0;
      })
      .map((r) => {
        const recordDate = new Date(r.date);
        // Whole-month age = difference in years * 12 + difference in months
        const ageMonths =
          (recordDate.getFullYear() - birthDate.getFullYear()) * 12 +
          (recordDate.getMonth() - birthDate.getMonth());
        return {
          ageMonths,
          date: r.date,
          value: (r[metric as keyof typeof r] as number) || 0,
        };
      })
      .sort((a, b) => a.ageMonths - b.ageMonths);

    // Return the structured chart dataset
    res.json({
      metric,
      childId: child.childId,
      childName: child.name,
      dataPoints,
    });
  } catch (err) {
    next(err);
  }
});

// ===== AI Health Analysis (SSE) =====

/**
 * System prompt template used for the AI health analysis request.
 * The model is instructed to act as a senior paediatrician and produce a
 * warm, structured Markdown report with a disclaimer.
 */
const ANALYSIS_PROMPT = `你是一位资深的儿科医生和儿童发育专家。请基于以下宝宝成长数据，生成一份专业的健康分析报告。

报告要求：
1. 用温暖鼓励的语气，先肯定父母的用心记录
2. 分析生长趋势（身高、体重、头围等）
3. 给出营养和作息建议
4. 如有需要注意的异常趋势，委婉提醒
5. 使用 Markdown 格式，分段清晰，适当使用 emoji
6. 最后加上一句免责声明：以上为AI初步分析，如有疑虑请咨询儿科医生`;

/**
 * POST /children/:childId/analysis
 *
 * Generates an AI-powered health analysis report for a child and streams the
 * result via Server-Sent Events (SSE).
 *
 * ## Flow
 * 1. Fetch the child and their records from the store.
 * 2. If no records exist, return 400 immediately (nothing to analyse).
 * 3. Build a structured text summary of all growth records.
 * 4. Construct a chat-completion message with a system prompt (paediatrician
 *    persona) and the user-facing summary.
 * 5. Initiate an SSE stream (`text/event-stream`) and forward each token
 *    produced by `chatStream` to the client.
 * 6. On completion, emit a `[DONE]` SSE event and close the stream.
 * 7. On failure during streaming, emit an `ANALYSIS_ERROR` SSE event before
 *    closing the stream so the client can surface the error gracefully.
 *
 * ## Edge Cases
 * - **No records**: returns 400 with `NO_RECORDS` code.
 * - **Child not found**: returns 404 with `NOT_FOUND` code.
 * - **AI service error during streaming**: the client receives an
 *   `ANALYSIS_ERROR` SSE event; the connection stays in a cleanly-closed state.
 * - **Store fetch failure**: returns a standard 500 JSON error (handled by
 *   the outer catch).
 *
 * @param req — Express Request with `req.params.childId`
 * @param res — Express Response (SSE stream, NOT a JSON response)
 * @returns   SSE stream:
 *            - `token` events for each text chunk
 *            - `done` event on successful completion
 *            - `error` event on AI failure
 * @error     404 (`NOT_FOUND`) when the child does not exist
 * @error     400 (`NO_RECORDS`) when the child has zero growth records
 * @error     500 (`INTERNAL_ERROR`) when the store fetch fails
 */
growthRouter.post('/children/:childId/analysis', async (req, res) => {
  const childId = req.params.childId;

  try {
    // Step 1: Fetch the child profile
    const child = await store.getChild(childId);
    if (!child) {
      res.status(404).json({ error: '宝宝档案不存在', code: 'NOT_FOUND' });
      return;
    }

    // Step 2: Guard against empty datasets — the AI has nothing to analyse
    if (child.records.length === 0) {
      res.status(400).json({ error: '没有成长记录，无法分析', code: 'NO_RECORDS' });
      return;
    }

    // Step 3: Build a human-readable summary of all records, sorted by date
    const recordsSummary = child.records
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => {
        const parts: string[] = [`📅 ${r.date}`];
        // Only include fields that have a value (optional fields may be undefined)
        if (r.height) parts.push(`身高: ${r.height}cm`);
        if (r.weight) parts.push(`体重: ${r.weight}kg`);
        if (r.headCircumference) parts.push(`头围: ${r.headCircumference}cm`);
        if (r.sleepDuration) parts.push(`睡眠: ${r.sleepDuration}h`);
        if (r.diapers !== undefined) parts.push(`尿布: ${r.diapers}次`);
        if (r.feeding) parts.push(`喂养: ${r.feeding.type} ${r.feeding.amount || ''}${r.feeding.unit || ''}`);
        if (r.notes) parts.push(`备注: ${r.notes}`);
        return parts.join(' | ');
      })
      .join('\n');

    // Step 4: Build the user message combining profile metadata and record data
    const userMessage = `宝宝信息：
- 姓名: ${child.name}
- 性别: ${child.gender === 'male' ? '男' : '女'}
- 出生日期: ${child.birthDate}
- 记录数量: ${child.records.length} 条

成长记录：
${recordsSummary}

请分析以上数据，生成健康报告。`;

    // Construct the chat message array: system prompt + user data
    const messages = [
      { role: 'system' as const, content: ANALYSIS_PROMPT },
      { role: 'user' as const, content: userMessage },
    ];

    // Step 5: Begin SSE stream — sets headers (Content-Type, Cache-Control, etc.)
    initSSE(res);
    const messageId = uuidv4();

    try {
      // Step 6: Stream tokens from the AI model to the client one-by-one
      for await (const chunk of chatStream(messages)) {
        sendToken(res, chunk);
      }
      // Step 7: Signal successful completion and close the stream
      sendDone(res, messageId, 0);
      res.end();
    } catch (err: any) {
      // Streaming-level error — log and notify the client over the SSE channel
      // so the frontend can display a graceful error instead of a broken UI
      logger.error('分析生成失败:', err.message);
      sendError(res, 'ANALYSIS_ERROR', '生成分析报告时出现错误');
      res.end();
    }
  } catch (err: any) {
    // Store-level error — the stream was never started, so return regular JSON
    logger.error('分析请求失败:', err.message);
    res.status(500).json({ error: '服务器错误', code: 'INTERNAL_ERROR' });
  }
});
