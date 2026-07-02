/**
 * Authentication service layer.
 *
 * Encapsulates all auth business logic — registration, login, token management —
 * so route handlers stay thin (parse → delegate → respond).
 *
 * Design decisions:
 * - Passwords are hashed with bcryptjs (12 salt rounds — a good balance of
 *   security vs. latency for a parenting app).
 * - Access tokens are short-lived (default 15 min) and carried in the
 *   `Authorization` header. Refresh tokens are long-lived (default 7 days)
 *   and stored in an HttpOnly cookie + the `refresh_tokens` table for
 *   server-side revocation.
 * - Refresh token rotation: every refresh call issues a new refresh token
 *   and invalidates the old one, reducing the window for token theft.
 *
 * @module services/authService
 */

import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/connection.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';
import type { RegisterInput, LoginInput, UserResponse, AuthResponse, JwtPayload } from '../types/auth.js';

// ---- internal helpers ----

const BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt.
 * @internal
 */
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @internal
 */
async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Strip sensitive fields from a user DB row, returning only public fields.
 * @internal
 */
function toUserResponse(row: any): UserResponse {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname || '',
    avatar: row.avatar || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Issue an access token + refresh token pair for the given user.
 *
 * Side-effect: persists the refresh token to the `refresh_tokens` table.
 *
 * @returns The access token (short-lived) and refresh token (long-lived).
 * @internal
 */
function generateTokens(userId: string, email: string): { accessToken: string; refreshToken: string; accessExpiresIn: number } {
  const payload: JwtPayload = { userId, email };

  // Add a unique jti (JWT ID) to ensure each access token is distinct.
  const accessToken = jwt.sign(
    { ...payload, jti: uuidv4() },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn as any }
  );

  // Unique jti also for the refresh token.
  const refreshToken = jwt.sign(
    { ...payload, jti: uuidv4() },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn as any }
  );

  // Decode to get the actual expiry timestamp for DB storage.
  const decoded = jwt.decode(refreshToken) as { exp: number } | null;
  const expiresAt = decoded ? new Date(decoded.exp * 1000).toISOString() : '';

  // Persist the refresh token so we can revoke it server-side.
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(uuidv4(), userId, refreshToken, expiresAt);

  // Parse access expiry in seconds for the client.
  const accessExpiresIn = parseDurationSeconds(config.jwt.accessExpiresIn);

  return { accessToken, refreshToken, accessExpiresIn };
}

/**
 * Parse a duration string like "15m", "7d", "1h" into total seconds.
 * Returns 900 (15 min) as a safe fallback for unparseable values.
 * @internal
 */
function parseDurationSeconds(duration: string): number {
  const match = duration.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return 900; // fallback: 15 minutes

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 900;
  }
}

// ---- public API ----

/**
 * Register a new user account.
 *
 * @throws {AppError} 409 if the email is already registered.
 */
export async function register(input: RegisterInput): Promise<AuthResponse & { refreshToken: string }> {
  // Check email uniqueness.
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(input.email);
  if (existing) {
    throw new AppError(409, 'EMAIL_EXISTS', '该邮箱已被注册');
  }

  const passwordHash = await hashPassword(input.password);
  const userId = `u_${uuidv4().slice(0, 8)}`;

  db.prepare(
    `INSERT INTO users (id, email, password_hash, nickname, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(userId, input.email, passwordHash, input.nickname || '');

  const user = toUserResponse(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  const { accessToken, refreshToken, accessExpiresIn } = generateTokens(userId, user.email);

  return { user, accessToken, refreshToken, expiresIn: accessExpiresIn };
}

/**
 * Authenticate a user with email + password.
 *
 * @throws {AppError} 401 if the email doesn't exist or the password is wrong.
 */
export async function login(input: LoginInput): Promise<AuthResponse & { refreshToken: string }> {
  const row: any = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email);
  if (!row) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
  }

  const valid = await comparePassword(input.password, row.password_hash);
  if (!valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
  }

  const user = toUserResponse(row);
  const { accessToken, refreshToken, accessExpiresIn } = generateTokens(user.id, user.email);

  return { user, accessToken, refreshToken, expiresIn: accessExpiresIn };
}

/**
 * Validate a refresh token and issue a new access + refresh token pair.
 *
 * Implements refresh token rotation: the old refresh token is deleted and
 * a new one is created, so each refresh token can only be used once.
 *
 * @param rawToken - The refresh token string from the client's cookie.
 * @returns A new access token and expiry. The new refresh token is set via
 *          cookie by the route handler.
 * @throws {AppError} 401 if the token is invalid, expired, or already used.
 */
export async function refreshAccessToken(
  rawToken: string
): Promise<{ accessToken: string; refreshToken: string; accessExpiresIn: number }> {
  // 1. Verify the JWT signature and expiry.
  let payload: JwtPayload;
  try {
    payload = jwt.verify(rawToken, config.jwt.secret) as JwtPayload;
  } catch {
    throw new AppError(401, 'TOKEN_INVALID', '登录已过期，请重新登录');
  }

  // 2. Check that this exact token exists in the DB (not revoked / already used).
  const stored: any = db.prepare(
    'SELECT * FROM refresh_tokens WHERE token = ?'
  ).get(rawToken);

  if (!stored) {
    // Token was already used (rotation) — possible token theft; revoke all
    // tokens for this user as a precaution.
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(payload.userId);
    throw new AppError(401, 'TOKEN_REUSED', '登录已过期，请重新登录');
  }

  // 3. Delete the used refresh token (rotation).
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id);

  // 4. Issue a new pair.
  const tokens = generateTokens(payload.userId, payload.email);
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresIn: tokens.accessExpiresIn,
  };
}

/**
 * Revoke a specific refresh token (used on logout).
 *
 * Safe to call even if the token doesn't exist — it simply won't delete anything.
 */
export function revokeRefreshToken(rawToken: string): void {
  db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(rawToken);
}

/**
 * Look up a user by ID and return their public profile.
 *
 * @returns The user profile, or `null` if not found.
 */
export function getUserById(userId: string): UserResponse | null {
  const row: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  return toUserResponse(row);
}
