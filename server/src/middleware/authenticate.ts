/**
 * Authentication middleware.
 *
 * Verifies the JWT access token from incoming requests and populates
 * `req.user` with the decoded payload. Supports two modes:
 *
 * - **required** (default): returns 401 if no valid token is present.
 * - **optional**: populates `req.user` when a valid token is provided,
 *   but allows the request to proceed unauthenticated otherwise. Useful
 *   for endpoints that behave differently for logged-in users vs. guests.
 *
 * Token sources (checked in order):
 * 1. `Authorization: Bearer <token>` header (standard for REST calls)
 * 2. `?token=<token>` query parameter (necessary for SSE/EventSource,
 *    which does not support custom headers)
 *
 * Usage:
 * ```ts
 * import { authenticate } from '../middleware/authenticate.js';
 *
 * // Required auth
 * router.get('/protected', authenticate, handler);
 *
 * // Optional auth (explicit parameter)
 * router.get('/semi-public', authenticate(false), handler);
 * ```
 *
 * @module middleware/authenticate
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AppError } from './errorHandler.js';
import type { JwtPayload } from '../types/auth.js';

/**
 * Extract the access token from the request.
 *
 * Check order:
 *  1. `Authorization: Bearer <token>` header
 *  2. `token` query parameter (SSE / EventSource fallback)
 *
 * @returns The raw token string, or `undefined` if not found.
 * @internal
 */
function extractToken(req: Request): string | undefined {
  // 1. Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Query parameter (SSE fallback)
  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  return undefined;
}

/**
 * Create an Express middleware that authenticates requests via JWT.
 *
 * @param required - When `true` (the default), the middleware returns 401 if
 *   no valid token is found. When `false`, it silently proceeds — `req.user`
 *   will be `undefined` for unauthenticated requests.
 *
 * @returns An Express middleware function.
 */
export function authenticate(
  required: boolean = true
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      if (required) {
        next(new AppError(401, 'UNAUTHORIZED', '请先登录'));
        return;
      }
      // Optional mode: proceed without setting req.user.
      next();
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
      req.user = { userId: payload.userId, email: payload.email };
      next();
    } catch {
      if (required) {
        next(new AppError(401, 'TOKEN_INVALID', '登录已过期，请重新登录'));
        return;
      }
      // Optional mode: token was invalid but we still proceed.
      next();
    }
  };
}
