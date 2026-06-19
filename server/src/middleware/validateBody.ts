/**
 * Middleware: validateBody
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 * This middleware factory takes a Zod schema and returns an Express middleware
 * that validates `req.body` against that schema **before** the route handler
 * runs.  On success the parsed (and potentially defaulted / coerced) body is
 * written back to `req.body` so downstream handlers always work with clean,
 * typed data.  On failure it short-circuits the request by passing a
 * structured `AppError` (HTTP 400) to the Express error-handling chain.
 *
 * ---------------------------------------------------------------------------
 * Where it is used in the chain
 * ---------------------------------------------------------------------------
 * This middleware is typically the **first** middleware after the route path
 * in a route definition, sitting right before the controller / route handler.
 * It can also be applied at the router level via `router.use(...)` to protect
 * every route in a sub-router.
 *
 * Example usage:
 * ```
 * router.post('/api/users', validateBody(createUserSchema), createUserHandler);
 * ```
 *
 * The error it produces is caught by the global error handler (see
 * `errorHandler.ts`) which formats it into a consistent JSON envelope.
 *
 * ---------------------------------------------------------------------------
 * Supported error scenarios
 * ---------------------------------------------------------------------------
 * - **Zod validation failure** → 400 `VALIDATION_ERROR` with per-field
 *   `path` / `message` details.
 * - **Non-Zod errors** (e.g. a malformed body that breaks JSON parsing, or a
 *   bug inside a Zod `.transform()`) → forwarded to the next error handler
 *   as-is.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from './errorHandler.js';

/**
 * Create an Express middleware that validates `req.body` against the supplied
 * Zod schema.
 *
 * @param schema - A Zod schema object (object, array, primitive, etc.) used to
 *   parse and validate the incoming request body.
 *
 * @returns An Express middleware function `(req, _res, next) => void`.
 *
 * @next
 *   - **On success** — `next()` is called with **no arguments**.  The parsed
 *     body has been reassigned to `req.body` and the next middleware / route
 *     handler in the stack will receive it.
 *
 *   - **On Zod validation error** — `next(new AppError(400, ...))` is called.
 *     The error includes a human-readable Chinese message and a JSON-serialised
 *     array of `{ path, message }` objects, one per failing field.
 *
 *   - **On unexpected error** — `next(err)` passes the original error through
 *     so the global error handler can log it and return a generic 500 response.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      // ------------------------------------------------------------------
      // Parse & validate req.body against the Zod schema.
      //
      // `schema.parse()` will throw a ZodError if validation fails.  When
      // it succeeds we **replace** req.body with the parsed output so that
      // downstream handlers benefit from Zod's built-in features (default
      // values, coercions, stripping of unknown keys via `.strict()`, etc.).
      // ------------------------------------------------------------------
      req.body = schema.parse(req.body);

      // Validation passed — hand over to the next middleware / route handler.
      next();
    } catch (err) {
      // ------------------------------------------------------------------
      // Zod validation failure:
      //   Flatten each Zod issue into a simple { path, message } object so
      //   the API consumer gets actionable field-level feedback.  The
      //   details are embedded in a Chinese-language message for this app's
      //   target audience, then forwarded as an AppError with status 400.
      // ------------------------------------------------------------------
      if (err instanceof ZodError) {
        const details = err.errors.map((e) => ({
          path: e.path.join('.'),   // e.g. "address.street" for nested fields
          message: e.message,       // Zod's human-readable message (e.g. "Required")
        }));
        next(new AppError(400, 'VALIDATION_ERROR', `请求参数校验失败: ${JSON.stringify(details)}`));
        return;  // short-circuit — the error has been forwarded, don't call next() again
      }

      // ------------------------------------------------------------------
      // Unexpected error (e.g. JSON parse failure if body-parser hasn't run,
      // or an unhandled exception inside a Zod transform/refine).
      // Forward it unchanged to the global error handler which will treat it
      // as a generic 500.
      // ------------------------------------------------------------------
      next(err);
    }
  };
}
