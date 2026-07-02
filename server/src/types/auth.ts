/**
 * Authentication-related Zod schemas and TypeScript types.
 *
 * Schemas are used by the `validateBody` middleware to enforce input shape
 * at the route boundary. Types inferred from the schemas are used throughout
 * the auth service layer.
 *
 * @module types/auth
 */

import { z } from 'zod';

// ============================================================================
// Request schemas (validated at the route boundary)
// ============================================================================

/** Schema for the POST /api/auth/register request body. */
export const RegisterSchema = z.object({
  email: z
    .string()
    .email('请输入有效的邮箱地址'),
  password: z
    .string()
    .min(6, '密码至少需要 6 个字符')
    .max(128, '密码不能超过 128 个字符'),
  nickname: z
    .string()
    .max(32, '昵称不能超过 32 个字符')
    .optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

/** Schema for the POST /api/auth/login request body. */
export const LoginSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(1, '请输入密码'),
});
export type LoginInput = z.infer<typeof LoginSchema>;

// ============================================================================
// Response types (returned to the client)
// ============================================================================

/** Public user profile — never includes password_hash. */
export interface UserResponse {
  id: string;
  email: string;
  nickname: string;
  avatar: string;
  createdAt: string;
  updatedAt: string;
}

/** Payload embedded in access & refresh JWTs. */
export interface JwtPayload {
  userId: string;
  email: string;
}

/** Successful auth response (register / login). */
export interface AuthResponse {
  user: UserResponse;
  accessToken: string;
  expiresIn: number; // seconds until the access token expires
}
