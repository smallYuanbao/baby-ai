/**
 * @fileoverview API service layer for the Baby AI client application.
 *
 * Provides a centralized HTTP client for all backend communication, including:
 * - A base fetch wrapper with automatic JSON serialization/deserialization
 * - Authorization header injection (Bearer token)
 * - Automatic 401 refresh — on receiving a 401, tries to refresh the access
 *   token via the HttpOnly refresh-token cookie, then retries once
 * - Convenience methods for standard REST verbs (GET, POST, PUT, DELETE)
 * - File upload support via multipart/form-data
 * - Server-Sent Events (SSE) streaming for chat and AI-generated content
 * - Domain-specific API namespaces (growth tracking, interactive play)
 */

import { config } from '../config';

// ---- Token management ----

/** In-memory access token — never persisted to localStorage (XSS mitigation). */
let accessToken: string | null = null;

/** Retry flag to prevent infinite 401 → refresh loops. */
let isRefreshing = false;
/** Queue of callbacks awaiting token refresh. */
let refreshQueue: Array<(token: string | null) => void> = [];

/**
 * Store the current access token so all outgoing requests include it.
 * Called by AuthContext after login / register / session restore.
 */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Clear the access token. Called by AuthContext on logout.
 */
export function clearAccessToken(): void {
  accessToken = null;
}

/**
 * Get the current access token (for SSE / other direct use).
 */
export function getAccessToken(): string | null {
  return accessToken;
}

// ---- Error class ----

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---- Token refresh logic ----

/**
 * Attempt to refresh the access token via the HttpOnly refresh-token cookie.
 *
 * Only one refresh call runs at a time — concurrent requests that also get
 * 401 are queued and resolved once the refresh completes.
 *
 * @returns The new access token, or null if refresh failed.
 */
async function attemptRefresh(): Promise<string | null> {
  // If another request already triggered a refresh, queue this one.
  if (isRefreshing) {
    return new Promise((resolve) => {
      refreshQueue.push(resolve);
    });
  }

  isRefreshing = true;

  try {
    const res = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    if (res.ok) {
      const data = await res.json();
      const newToken = data.accessToken;
      setAccessToken(newToken);

      // Resolve all queued callers with the new token.
      refreshQueue.forEach((cb) => cb(newToken));
      refreshQueue = [];

      return newToken;
    }

    // Refresh failed — notify queue and clear token.
    refreshQueue.forEach((cb) => cb(null));
    refreshQueue = [];
    setAccessToken(null);
    return null;
  } catch {
    refreshQueue.forEach((cb) => cb(null));
    refreshQueue = [];
    setAccessToken(null);
    return null;
  } finally {
    isRefreshing = false;
  }
}

// ---- Core request ----

/**
 * Low-level fetch wrapper with auth header injection and 401 auto-refresh.
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.apiBaseUrl}${endpoint}`;

  // Inject Authorization header if we have a token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let response = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (response.status === 401 && accessToken) {
    const newToken = await attemptRefresh();

    if (newToken) {
      // Retry with the new token
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, { ...options, headers });
    }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.code || 'UNKNOWN',
      body.error || `请求失败: ${response.status}`,
    );
  }

  return response.json();
}

// ---- Convenience wrappers ----

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function put<T>(endpoint: string, body: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

async function del<T = { success: boolean }>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'DELETE' });
}

// ---- File upload (multipart) ----

async function uploadFile<T>(file: File): Promise<T> {
  const url = `${config.apiBaseUrl}/upload`;
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.code || 'UPLOAD_ERROR',
      body.error || '文件上传失败',
    );
  }

  return response.json();
}

// ---- SSE streaming ----

async function chatSSE(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  fileId?: string,
): Promise<Response> {
  const url = `${config.apiBaseUrl}/chat?stream=true`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Pass token both as header AND as query param for SSE compatibility.
  // The server's authenticate middleware checks both.
  const token = accessToken;
  const urlWithToken = token ? `${url}&token=${encodeURIComponent(token)}` : url;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(urlWithToken, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ message, history, fileId }),
  });
}

// ---- Public API surface ----

export const api = {
  get: request,
  post,
  put,
  del,
  uploadFile,
  chatSSE,

  growth: {
    listChildren: () =>
      request<any[]>('/growth/children'),

    getChild: (childId: string) =>
      request<any>(`/growth/children/${childId}`),

    createChild: (data: { name: string; birthDate: string; gender: string }) =>
      post<any>('/growth/children', data),

    updateChild: (childId: string, data: { name?: string; birthDate?: string; gender?: string }) =>
      put<any>(`/growth/children/${childId}`, data),

    deleteChild: (childId: string) =>
      del(`/growth/children/${childId}`),

    addRecord: (childId: string, data: any) =>
      post<any>(`/growth/children/${childId}/records`, data),

    updateRecord: (childId: string, recordId: string, data: any) =>
      put<any>(`/growth/children/${childId}/records/${recordId}`, data),

    deleteRecord: (childId: string, recordId: string) =>
      del(`/growth/children/${childId}/records/${recordId}`),

    getChartData: (childId: string, metric: string) =>
      request<any>(`/growth/children/${childId}/chart-data?metric=${metric}`),

    requestAnalysis: (childId: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      const token = accessToken;
      const queryToken = token ? `?token=${encodeURIComponent(token)}` : '';
      return fetch(`${config.apiBaseUrl}/growth/children/${childId}/analysis${queryToken}`, {
        method: 'POST',
        headers,
      });
    },
  },

  play: {
    requestStory: (childAge: number, interest?: string, storyType?: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      const token = accessToken;
      const queryToken = token ? `?token=${encodeURIComponent(token)}` : '';
      return fetch(`${config.apiBaseUrl}/play/story${queryToken}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ childAge, interest, storyType }),
      });
    },

    getRiddle: (childAge: number, difficulty?: string) =>
      post<any>('/play/riddle', { childAge, difficulty }),

    guessRiddle: (riddleId: string, guess?: string, hint?: boolean) =>
      post<any>('/play/riddle/guess', { riddleId, guess, hint }),

    interpretBabyTalk: (description: string, babyAge?: number) =>
      post<any>('/play/baby-talk', { description, babyAge }),
  },
};
