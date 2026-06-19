/**
 * @fileoverview API service layer for the Baby AI client application.
 *
 * Provides a centralized HTTP client for all backend communication, including:
 * - A base fetch wrapper with automatic JSON serialization/deserialization
 * - Convenience methods for standard REST verbs (GET, POST, PUT, DELETE)
 * - File upload support via multipart/form-data
 * - Server-Sent Events (SSE) streaming for chat and AI-generated content
 * - Domain-specific API namespaces (growth tracking, interactive play)
 *
 * All requests are routed through {@link config.apiBaseUrl} and errors are
 * normalised into {@link ApiError} instances carrying a status code, an
 * application-level error code, and a human-readable message.
 */

import { config } from '../config';

/**
 * Custom error thrown when an API response carries a non-OK status.
 *
 * Normalises HTTP errors so callers can handle them uniformly without
 * inspecting raw Response objects. The `code` field mirrors the server-side
 * error code (e.g. "VALIDATION_ERROR", "NOT_FOUND") while `message` carries
 * a user-facing description.
 */
class ApiError extends Error {
  constructor(
    /** HTTP status code returned by the server */
    public status: number,
    /** Application-level error code (e.g. "UPLOAD_ERROR", "UNKNOWN") */
    public code: string,
    /** Human-readable error description */
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Low-level fetch wrapper used by all REST helpers.
 *
 * Prepends {@link config.apiBaseUrl} to the given endpoint, merges default
 * JSON headers with caller-supplied headers, and parses the JSON response
 * body. Non-OK responses are thrown as {@link ApiError}.
 *
 * @param endpoint - URL path relative to the API base (e.g. "/growth/children")
 * @param options  - Standard Fetch API RequestInit overrides (method, body,
 *                   headers, etc.)
 * @returns The JSON-parsed response body cast to the generic type `T`
 * @throws {ApiError} When the response status is not OK (outside 2xx range)
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.apiBaseUrl}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      // Spread caller-supplied headers last so they can override
      // the default Content-Type when needed (e.g. for form uploads).
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    // Gracefully fall back to an empty object when the error response
    // body isn't valid JSON — the ApiError constructor still receives
    // sane defaults for `code` and `error`.
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.code || 'UNKNOWN',
      body.error || `请求失败: ${response.status}`,
    );
  }

  return response.json();
}

/**
 * Convenience wrapper for POST requests with a JSON body.
 *
 * Serialises `body` via `JSON.stringify` and delegates to {@link request}.
 *
 * @param endpoint - URL path relative to the API base
 * @param body     - Payload to be serialised with `JSON.stringify`
 * @returns The JSON-parsed response body
 * @template T - Expected shape of the response data
 */
async function post<T>(endpoint: string, body: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Uploads a single file to the /upload endpoint using multipart/form-data.
 *
 * Unlike the JSON helpers above, this constructs a {@link FormData} payload
 * so the browser sets the correct `Content-Type` boundary automatically.
 * Does NOT go through {@link request} because that helper always sets
 * `Content-Type: application/json`.
 *
 * @param file - The browser File object to upload
 * @returns The JSON-parsed response body
 * @throws {ApiError} When the upload fails (non-OK response)
 */
async function uploadFile<T>(file: File): Promise<T> {
  const url = `${config.apiBaseUrl}/upload`;
  // Use FormData so the browser automatically sets the correct
  // multipart/form-data Content-Type with boundary.
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    // Gracefully fall back to an empty object when the error response
    // body isn't valid JSON, so the ApiError constructor still receives
    // sane defaults for `code` and `error`.
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.code || 'UPLOAD_ERROR',
      body.error || '文件上传失败',
    );
  }

  return response.json();
}

/**
 * Initiates a streaming chat request via Server-Sent Events (SSE).
 *
 * Returns the raw {@link Response} object rather than parsed JSON so callers
 * can read the streaming body chunk-by-chunk (e.g. via
 * `response.body.getReader()`). The backend is expected to respond with
 * `text/event-stream`.
 *
 * @param message - The latest user message to send
 * @param history - Conversation history as an ordered list of role/content pairs
 * @param fileId  - Optional ID of a previously uploaded file to attach context
 * @returns The raw fetch Response for SSE consumption
 */
async function chatSSE(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  fileId?: string,
): Promise<Response> {
  const url = `${config.apiBaseUrl}/chat?stream=true`;

  // Return the raw Response so callers can consume the SSE stream
  // via response.body.getReader() — we intentionally skip .json() here.
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, fileId }),
  });
}

/**
 * Convenience wrapper for PUT requests with a JSON body.
 *
 * Serialises `body` via `JSON.stringify` and delegates to {@link request}.
 *
 * @param endpoint - URL path relative to the API base
 * @param body     - Payload to be serialised with `JSON.stringify`
 * @returns The JSON-parsed response body
 * @template T - Expected shape of the response data
 */
async function put<T>(endpoint: string, body: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Convenience wrapper for DELETE requests (no request body).
 *
 * Defaults the generic type to `{ success: boolean }` so callers can check
 * success without providing their own type annotation.
 *
 * @param endpoint - URL path relative to the API base
 * @returns The JSON-parsed response body
 * @template T - Expected shape of the response data (defaults to
 *               `{ success: boolean }`)
 */
async function del<T = { success: boolean }>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'DELETE' });
}

/**
 * Public API surface for the Baby AI client.
 *
 * Organises all backend calls into a flat set of HTTP verb helpers
 * (`get`, `post`, `put`, `del`) plus special-purpose methods
 * (`uploadFile`, `chatSSE`) and domain-specific namespaces:
 *
 * - **growth** — child profile CRUD, growth records, chart data, and AI analysis
 * - **play**   — interactive storytelling (SSE), riddles, and baby-talk interpretation
 *
 * @example
 * ```ts
 * import { api } from './services/api';
 *
 * const children = await api.growth.listChildren();
 * const storyStream = await api.play.requestStory(4, 'animals');
 * ```
 */
export const api = {
  get: request,
  post,
  put,
  del,
  uploadFile,
  chatSSE,

  // =========================================================================
  // Growth API — manage child profiles, growth records, and AI-powered analysis
  // =========================================================================
  growth: {
    /** List all registered children for the current user. */
    listChildren: () =>
      request<any[]>('/growth/children'),

    /** Fetch a single child's profile by ID. */
    getChild: (childId: string) =>
      request<any>(`/growth/children/${childId}`),

    /** Create a new child profile with basic demographics. */
    createChild: (data: { name: string; birthDate: string; gender: string }) =>
      post<any>('/growth/children', data),

    /** Update an existing child's profile fields (partial update). */
    updateChild: (childId: string, data: { name?: string; birthDate?: string; gender?: string }) =>
      put<any>(`/growth/children/${childId}`, data),

    /** Delete a child's profile and all associated records. */
    deleteChild: (childId: string) =>
      del(`/growth/children/${childId}`),

    /** Add a new growth record (height, weight, etc.) for a child. */
    addRecord: (childId: string, data: any) =>
      post<any>(`/growth/children/${childId}/records`, data),

    /** Update an existing growth record. */
    updateRecord: (childId: string, recordId: string, data: any) =>
      put<any>(`/growth/children/${childId}/records/${recordId}`, data),

    /** Delete a specific growth record. */
    deleteRecord: (childId: string, recordId: string) =>
      del(`/growth/children/${childId}/records/${recordId}`),

    /** Retrieve chart data for a given metric (height, weight, BMI, etc.). */
    getChartData: (childId: string, metric: string) =>
      request<any>(`/growth/children/${childId}/chart-data?metric=${metric}`),

    /**
     * Request an AI-powered growth analysis.
     *
     * Returns the raw fetch {@link Response} so callers can consume the
     * SSE stream — the backend streams analysis text as it is generated.
     */
    requestAnalysis: (childId: string) =>
      fetch(`${config.apiBaseUrl}/growth/children/${childId}/analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
  },

  // =========================================================================
  // Play API — interactive stories, riddles, and baby-talk interpretation
  // =========================================================================
  play: {
    /**
     * Request an AI-generated story tailored to the child's age and interests.
     *
     * Returns the raw fetch {@link Response} for SSE streaming — the story
     * text arrives incrementally as the LLM generates it.
     */
    requestStory: (childAge: number, interest?: string, storyType?: string) =>
      fetch(`${config.apiBaseUrl}/play/story`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childAge, interest, storyType }),
      }),

    /** Fetch a riddle suitable for the given child age and difficulty. */
    getRiddle: (childAge: number, difficulty?: string) =>
      post<any>('/play/riddle', { childAge, difficulty }),

    /**
     * Submit a guess for a riddle or request a hint.
     *
     * Pass `hint: true` to get a hint instead of checking a guess.
     */
    guessRiddle: (riddleId: string, guess?: string, hint?: boolean) =>
      post<any>('/play/riddle/guess', { riddleId, guess, hint }),

    /** Interpret a parent's description of their baby's sounds/gestures using AI. */
    interpretBabyTalk: (description: string, babyAge?: number) =>
      post<any>('/play/baby-talk', { description, babyAge }),
  },
};
