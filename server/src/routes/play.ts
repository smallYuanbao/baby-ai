/**
 * Play Routes — interactive parent-child features for the baby-ai app.
 *
 * Endpoints defined in this file:
 *   POST /play/story       – SSE-streamed story generation (child-age–aware)
 *   POST /play/riddle      – AI-generated riddle (answer stored server-side)
 *   POST /play/riddle/guess – Verify a riddle answer or request a hint
 *   POST /play/baby-talk   – Interpret baby behaviour descriptions as "baby talk"
 *
 * All endpoints use Zod schemas for request-body validation (via validateBody
 * middleware). Riddle answers are held in an in-memory Map with a 5-minute TTL.
 *
 * @module playRouter
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { validateBody } from '../middleware/validateBody.js';
import { chat, chatStream } from '../services/deepseek.js';
import { initSSE, sendToken, sendDone, sendError } from '../utils/sse.js';
import { STORY_PROMPT, RIDDLE_PROMPT, BABY_TALK_PROMPT } from '../services/playPrompts.js';
import logger from '../utils/logger.js';

export const playRouter = Router();

/* ---- Zod Schemas ---- */

/** Schema for POST /play/story — validates a story-generation request. */
const StoryRequestSchema = z.object({
  /** Child's age in years (0–12). */
  childAge: z.number().int().min(0).max(12),
  /** Optional interest keyword (e.g. "dinosaurs"); max 100 chars. */
  interest: z.string().max(100).optional(),
  /** Optional story genre: bedtime, adventure, or educational. */
  storyType: z.enum(['bedtime', 'adventure', 'educational']).optional(),
});

/** Schema for POST /play/riddle — validates a riddle-generation request. */
const RiddleRequestSchema = z.object({
  /** Child's age in years (0–12). */
  childAge: z.number().int().min(0).max(12),
  /** Optional difficulty level; defaults to AI-determined when omitted. */
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
});

/** Schema for POST /play/riddle/guess — validates a guess or hint request. */
const RiddleGuessSchema = z.object({
  /** The riddle ID returned by POST /play/riddle. */
  riddleId: z.string(),
  /** The child's answer string (omit when requesting a hint). */
  guess: z.string().optional(),
  /** Set to true to request the next hint instead of submitting a guess. */
  hint: z.boolean().optional(),
});

/** Schema for POST /play/baby-talk — validates a baby-talk interpretation request. */
const BabyTalkRequestSchema = z.object({
  /** Description of what the baby is doing / how they are behaving (2–500 chars). */
  description: z.string().min(2).max(500),
  /** Optional baby age in months (0–36); improves contextual interpretation. */
  babyAge: z.number().int().min(0).max(36).optional(),
});

/**
 * In-memory store for active riddles.
 *
 * Each entry maps a riddleId to its answer, available hints, and creation
 * timestamp. Entries expire after 5 minutes (300 000 ms) — a background
 * interval sweeps the map every 60 seconds.
 *
 * Edge case: if the server restarts all riddles are lost; clients receive a
 * 404 with code RIDDLE_EXPIRED and should ask for a new riddle.
 */
const riddleStore = new Map<string, { answer: string; hints: string[]; createdAt: number }>();

// Periodically purge expired riddles (TTL = 5 minutes).
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of riddleStore) {
    if (now - val.createdAt > 300000) riddleStore.delete(key);
  }
}, 60000);

/* ---- Routes ---- */

/**
 * POST /play/story — generate a child-friendly story via SSE stream.
 *
 * Builds a natural-language prompt from the child's age, optional interest,
 * and optional story type, then streams tokens back to the client over
 * Server-Sent Events (SSE).
 *
 * @param {Request}  req  – Express request; body validated by StoryRequestSchema.
 * @param {Response} res  – Express response; SSE stream with real-time token
 *   delivery. The stream ends with a `sendDone` frame carrying the messageId
 *   and a usage token count, or a `sendError` frame on failure.
 *
 * Method:  POST
 * Path:    /play/story
 *
 * Error scenarios:
 *   - DeepSeek API failure → SSE error frame with code STORY_ERROR.
 */
playRouter.post('/story', validateBody(StoryRequestSchema), async (req, res) => {
  // Extract validated fields from the request body.
  const { childAge, interest, storyType } = req.body;

  // Compose the user-facing message that seeds the story generation.
  let userMessage = `请为${childAge}岁的小朋友创作一个故事。`;
  if (storyType) {
    // Map the enum values to Chinese genre labels.
    const typeMap: Record<string, string> = { bedtime: '睡前故事', adventure: '冒险故事', educational: '教育故事' };
    userMessage += `故事类型：${typeMap[storyType]}。`;
  }
  if (interest) {
    userMessage += `小朋友喜欢：${interest}。`;
  }

  // Initialize the SSE connection — sets headers and keeps the response open.
  initSSE(res);
  const messageId = uuidv4();

  try {
    // Stream tokens from DeepSeek one chunk at a time.
    for await (const chunk of chatStream([
      { role: 'system', content: STORY_PROMPT },
      { role: 'user', content: userMessage },
    ])) {
      sendToken(res, chunk);
    }
    // Signal successful completion with a final SSE frame.
    sendDone(res, messageId, 0);
    res.end();
  } catch (err: any) {
    logger.error('故事生成失败:', err.message);
    // Send a structured SSE error so the client can display a friendly message.
    sendError(res, 'STORY_ERROR', '生成故事时出现错误');
    res.end();
  }
});

/**
 * POST /play/riddle — generate a new riddle for a child.
 *
 * Calls DeepSeek with a system prompt tuned for child-appropriate riddles.
 * The returned JSON is parsed to extract the riddle text, answer, and hints.
 * The answer is stored server-side (in-memory) and never sent to the client.
 *
 * @param {Request}  req  – Express request; body validated by RiddleRequestSchema.
 * @param {Response} res  – Express response; JSON object containing:
 *   - `riddleId`   – unique ID the client uses for subsequent guess requests
 *   - `riddle`     – the riddle question text
 *   - `category`   – topic category (e.g. "动物", "生活")
 *   - `difficulty` – difficulty level
 * @param {NextFunction} next – Express next function; passed the error if
 *   DeepSeek fails.
 *
 * Method:  POST
 * Path:    /play/riddle
 *
 * Error scenarios:
 *   - AI does not return valid JSON → fallback to a default riddle shape so
 *     the game can continue (answer is set to a placeholder; hints are minimal).
 *   - DeepSeek API failure → forwarded to the global error handler via next(err).
 */
playRouter.post('/riddle', validateBody(RiddleRequestSchema), async (req, res, next) => {
  // Extract validated fields.
  const { childAge, difficulty } = req.body;

  // Build the AI prompt with age and optional difficulty.
  let userMessage = `请为${childAge}岁的小朋友设计一个谜语。`;
  if (difficulty) userMessage += `难度：${difficulty}。`;

  try {
    // Non-streaming call — we need the full JSON response at once.
    const { content } = await chat([
      { role: 'system', content: RIDDLE_PROMPT },
      { role: 'user', content: userMessage },
    ], { temperature: 0.8 });

    /**
     * Parse the AI response as JSON.
     *
     * Edge case: the model may wrap the JSON in markdown code fences (```json … ```).
     * We attempt a regex extraction first; if that fails we try a direct parse.
     * If both fail we fall back to a safe default so the game does not break.
     */
    let riddleData: any;
    try {
      // Try to extract the first JSON object from the response text.
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      riddleData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
    } catch {
      // Fallback: treat the entire response as the riddle text.
      riddleData = {
        riddle: content.trim(),
        category: '生活',
        difficulty: 'easy',
        answer: '（答案生成失败）',
        hints: ['再想想吧~'],
      };
    }

    // Persist answer + hints server-side so the client cannot peek.
    const riddleId = `rid_${uuidv4().slice(0, 8)}`;
    riddleStore.set(riddleId, {
      answer: riddleData.answer || '',
      hints: riddleData.hints || [],
      createdAt: Date.now(),
    });

    // Return only the public-facing fields (answer is omitted).
    res.json({
      riddleId,
      riddle: riddleData.riddle,
      category: riddleData.category,
      difficulty: riddleData.difficulty,
    });
  } catch (err) {
    // Forward to Express global error handler.
    next(err);
  }
});

/**
 * POST /play/riddle/guess — submit a guess or request a hint for an active
 * riddle.
 *
 * The endpoint supports two modes controlled by the `hint` flag in the body:
 *   - hint=true  → returns the next available hint for the riddle.
 *   - hint=false → evaluates the submitted guess against the stored answer.
 *
 * @param {Request}  req  – Express request; body validated by RiddleGuessSchema.
 * @param {Response} res  – Express response.
 *
 *   Guess mode (hint omitted or false):
 *     - Correct   → `{ correct: true,  answer, encouragement }`  (riddle deleted)
 *     - Incorrect → `{ correct: false, encouragement }`
 *
 *   Hint mode (hint=true):
 *     - `{ hint, correct: false }`
 *
 *   Error mode:
 *     - 404 `{ error, code: 'RIDDLE_EXPIRED' }` when the riddle is unknown/expired.
 *     - 400 `{ error, code: 'NO_GUESS' }` when a guess is expected but missing/empty.
 *
 * Method:  POST
 * Path:    /play/riddle/guess
 *
 * Edge cases:
 *   - Concurrent hint requests consume hints one at a time (shift).
 *   - Answer matching uses fuzzy logic: exact match, substring containment
 *     (guess includes answer, or answer includes guess) to be lenient with
 *     children's input.
 *   - On a correct guess the riddle is immediately deleted to prevent replay.
 */
playRouter.post('/riddle/guess', validateBody(RiddleGuessSchema), async (req, res) => {
  const { riddleId, guess, hint } = req.body;

  // Look up the riddle in the in-memory store.
  const stored = riddleStore.get(riddleId);

  // If the riddle has expired or never existed, tell the client to request a new one.
  if (!stored) {
    res.status(404).json({ error: '谜语已过期，请重新出题', code: 'RIDDLE_EXPIRED' });
    return;
  }

  // --- Hint mode ---
  if (hint) {
    const nextHintIdx = 0; // 简单实现：每次给第一个还没给的提示
    // Consume the first available hint (destructive — each hint is given only once).
    const hintText = stored.hints.length > 0 ? stored.hints[0] : '没有更多提示啦~';
    stored.hints.shift(); // Remove the hint so the next request gets a different one.
    res.json({ hint: hintText, correct: false });
    return;
  }

  // --- Guess mode ---

  // Guard against empty / whitespace-only input.
  if (!guess || !guess.trim()) {
    res.status(400).json({ error: '请输入你的答案', code: 'NO_GUESS' });
    return;
  }

  /**
   * Fuzzy match: accept an exact match, or if either string is a substring of
   * the other. This makes the experience friendlier for young children who may
   * type partial answers.
   */
  const isCorrect = guess.trim() === stored.answer ||
    guess.trim().includes(stored.answer) ||
    stored.answer.includes(guess.trim());

  if (isCorrect) {
    // Delete the riddle immediately — one correct guess per riddle.
    riddleStore.delete(riddleId);
    // Randomly select a positive encouragement message.
    const encouragements = [
      '太棒了！你真聪明！🌟',
      '答对啦！你好厉害！🎉',
      '完全正确！看来你是个猜谜高手！🏆',
    ];
    res.json({
      correct: true,
      answer: stored.answer,
      encouragement: encouragements[Math.floor(Math.random() * encouragements.length)],
    });
  } else {
    res.json({
      correct: false,
      encouragement: '不对哦，再想想！💪',
    });
  }
});

/**
 * POST /play/baby-talk — interpret baby behaviour as "what the baby would say."
 *
 * Takes a free-text description of a baby's actions / sounds and optionally the
 * baby's age in months, then returns a playful "translation" generated by the
 * AI. Useful for parents who want a fun, light-hearted interpretation.
 *
 * @param {Request}  req  – Express request; body validated by BabyTalkRequestSchema.
 * @param {Response} res  – Express response; JSON `{ interpretation: string }`.
 * @param {NextFunction} next – Express next function; forwards errors to the
 *   global error handler.
 *
 * Method:  POST
 * Path:    /play/baby-talk
 *
 * Error scenarios:
 *   - DeepSeek API failure → forwarded to global error handler via next(err).
 *   - Empty / overly short description → rejected by Zod validation (min 2 chars).
 */
playRouter.post('/baby-talk', validateBody(BabyTalkRequestSchema), async (req, res, next) => {
  // Extract validated fields.
  const { description, babyAge } = req.body;

  // Build the prompt. Baby age is optional and improves context.
  let userMessage = `宝宝表现描述：${description}`;
  if (babyAge !== undefined) {
    userMessage += `\n宝宝年龄：${babyAge}个月`;
  }

  try {
    // Non-streaming call with higher temperature for creative outputs.
    const { content } = await chat([
      { role: 'system', content: BABY_TALK_PROMPT },
      { role: 'user', content: userMessage },
    ], { temperature: 0.9, maxTokens: 500 });

    // Return the AI's interpretation as a plain JSON field.
    res.json({ interpretation: content });
  } catch (err) {
    // Forward to Express global error handler.
    next(err);
  }
});
