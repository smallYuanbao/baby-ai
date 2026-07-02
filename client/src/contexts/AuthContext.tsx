/**
 * Authentication context — global auth state for the Baby AI client.
 *
 * Provides:
 * - `user` — current user profile (null when not logged in)
 * - `isAuthenticated` — boolean shorthand
 * - `isLoading` — true during initial token refresh / session restore
 * - `login()` / `register()` / `logout()` — auth actions
 *
 * Architecture:
 * - Access tokens are held in a module-level variable (NOT localStorage)
 *   to reduce XSS exposure. They are passed to `api.setAccessToken()`.
 * - Refresh tokens are stored in an HttpOnly cookie (set by the server),
 *   so JavaScript never sees them.
 * - On mount, the provider calls POST /api/auth/refresh to obtain an
 *   initial access token (the cookie is sent automatically via credentials),
 *   then GET /api/auth/me to load the user profile.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { config } from '../config';
import { setAccessToken, clearAccessToken } from '../services/api';

// ---- types ----

export interface User {
  id: string;
  email: string;
  nickname: string;
  avatar: string;
  createdAt: string;
  updatedAt: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, nickname?: string) => Promise<void>;
  logout: () => Promise<void>;
}

// ---- context ----

const AuthContext = createContext<AuthState | null>(null);

/**
 * Hook to consume auth state. Must be used inside `<AuthProvider>`.
 */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

// ---- helpers ----

/** POST to an auth endpoint and return the parsed JSON. */
async function authFetch(endpoint: string, body?: Record<string, unknown>): Promise<any> {
  const url = `${config.apiBaseUrl}/auth${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // send HttpOnly refresh-token cookie
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

// ---- provider ----

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * On mount: try to restore a session from the refresh token cookie.
   * If the cookie is valid we get back an access token + user profile.
   * If the cookie is missing or expired we silently remain unauthenticated.
   */
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        // Step 1: exchange refresh cookie for a new access token
        const refreshData = await authFetch('/refresh');

        if (refreshData.accessToken) {
          setAccessToken(refreshData.accessToken);

          // Step 2: fetch the user profile with the new access token
          const meUrl = `${config.apiBaseUrl}/auth/me`;
          const meRes = await fetch(meUrl, {
            headers: {
              'Authorization': `Bearer ${refreshData.accessToken}`,
            },
          });

          if (meRes.ok) {
            const meData = await meRes.json();
            if (!cancelled) {
              setUser(meData.user);
            }
          }
        }
      } catch {
        // No valid session — user stays logged out. This is normal for
        // first-time visitors and users whose refresh token has expired.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    restoreSession();
    return () => { cancelled = true; };
  }, []);

  /**
   * Log in with email + password.
   *
   * @throws {Error} with a human-readable message on failure.
   */
  const login = useCallback(async (email: string, password: string) => {
    const data = await authFetch('/login', { email, password });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  /**
   * Register a new account and automatically log in.
   *
   * @throws {Error} with a human-readable message on failure.
   */
  const register = useCallback(async (email: string, password: string, nickname?: string) => {
    const data = await authFetch('/register', { email, password, nickname });
    setAccessToken(data.accessToken);
    setUser(data.user);
  }, []);

  /**
   * Log out: revoke the refresh token server-side, clear local state.
   */
  const logout = useCallback(async () => {
    try {
      await authFetch('/logout');
    } catch {
      // Even if the server call fails, clear local state — the user
      // should not be locked in.
    }
    clearAccessToken();
    setUser(null);
  }, []);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
    isLoading,
    login,
    register,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
