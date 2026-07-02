/**
 * Authentication route handlers.
 *
 * Exposes RESTful endpoints for:
 * - POST /register  — create a new account
 * - POST /login     — sign in with email + password
 * - POST /refresh   — obtain a new access token using a refresh token cookie
 * - POST /logout    — revoke the current refresh token
 * - GET  /me        — return the current user's profile (requires auth)
 *
 * Cookie policy for the refresh token:
 * - `httpOnly`  — not readable by JavaScript (mitigates XSS)
 * - `secure`    — only sent over HTTPS in production
 * - `sameSite`  — `lax` allows the cookie on top-level navigations but blocks
 *                 it on cross-site subrequests
 * - `path`      — scoped to `/api/auth` so the cookie is only sent on auth
 *                 endpoints, reducing unnecessary exposure
 *
 * @module routes/auth
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { RegisterSchema, LoginSchema } from '../types/auth.js';
import { validateBody } from '../middleware/validateBody.js';
import { authenticate } from '../middleware/authenticate.js';
import * as authService from '../services/authService.js';
import logger from '../utils/logger.js';

export const authRouter = Router();

// ---- cookie helpers ----

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Build standard cookie options for the refresh token. */
function refreshCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  };
}

/** Set the refresh token as an HttpOnly cookie on the response. */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

/** Clear the refresh token cookie. */
function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: 0 });
}

/** Read the refresh token from the request cookies. */
function getRefreshToken(req: Request): string | undefined {
  return req.cookies?.[REFRESH_COOKIE] || undefined;
}

// ---- routes ----

/**
 * POST /register
 *
 * Create a new user account. Returns user profile + access token,
 * and sets the refresh token as an HttpOnly cookie.
 */
authRouter.post(
  '/register',
  validateBody(RegisterSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.register(req.body);
      setRefreshCookie(res, result.refreshToken);
      res.status(201).json({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /login
 *
 * Authenticate with email + password. Returns user profile + access token,
 * and sets the refresh token as an HttpOnly cookie.
 */
authRouter.post(
  '/login',
  validateBody(LoginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.login(req.body);
      setRefreshCookie(res, result.refreshToken);
      res.json({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /refresh
 *
 * Exchange a valid refresh token (from cookie) for a new access + refresh
 * token pair. Implements refresh token rotation — old token is revoked.
 */
authRouter.post(
  '/refresh',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oldToken = getRefreshToken(req);
      if (!oldToken) {
        res.status(401).json({ error: '未提供刷新令牌', code: 'NO_REFRESH_TOKEN' });
        return;
      }

      const result = await authService.refreshAccessToken(oldToken);
      setRefreshCookie(res, result.refreshToken);
      res.json({
        accessToken: result.accessToken,
        expiresIn: result.accessExpiresIn,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /logout
 *
 * Revoke the current refresh token and clear the cookie.
 */
authRouter.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = getRefreshToken(req);
      if (token) {
        authService.revokeRefreshToken(token);
      }
      clearRefreshCookie(res);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /me
 *
 * Return the currently authenticated user's profile.
 * Requires a valid access token in the Authorization header.
 */
authRouter.get(
  '/me',
  authenticate(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = authService.getUserById(req.user!.userId);
      if (!user) {
        res.status(404).json({ error: '用户不存在', code: 'USER_NOT_FOUND' });
        return;
      }
      res.json({ user });
    } catch (err) {
      next(err);
    }
  }
);
