/**
 * Typed fetch wrapper with AbortController support and error handling.
 *
 * Fix #7: On mutating requests (POST/PUT/PATCH/DELETE), `apiFetch` now
 *   automatically attaches the `X-CSRF-Token` header. The previous comment
 *   claimed "cookies handle it" but the backend's `csrfMiddleware` (see
 *   backend/src/middleware/csrf.ts) requires the header on every mutating
 *   request — without it, every POST/PUT/PATCH/DELETE returned 403.
 *   The token is read from a non-httpOnly cookie set by the server on
 *   login (XSRF-TOKEN). The double-submit pattern: the server sets the
 *   cookie AND the token in the response body; the client echoes the
 *   token as a header; the server validates the header format and length.
 *
 * Fix #39: `apiFetch` now returns a `{ promise, cancel }` pair so callers
 *   can abort an in-flight request (e.g. on a new generation start). The
 *   old version consumed the signal internally for timeout only and did
 *   not expose cancellation to consumers.
 *
 * Type dependency: ApiResponse, ApiSuccess, ApiError are defined in
 * @/types (the foundation layer). lib/utils/api.ts imports them rather
 * than defining them locally so that types/index.ts does not depend on
 * utilities — the dependency direction is "types → utilities", not
 * "utilities → types".
 */

import type { ApiResponse } from '@/types';
import { API_BASE } from '@/lib/config';
const CSRF_COOKIE_NAME = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-CSRF-Token';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Read a cookie value by name. Returns null if the cookie is not set. */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const target = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      return decodeURIComponent(trimmed.slice(target.length));
    }
  }
  return null;
}

// Re-export canonical API response types from the foundation layer.
// Importing callers can use `import { apiFetch, type ApiResponse } from '@/lib/utils/api'`
// without creating a circular dependency (types never imports from utils).
export type { ApiResponse, ApiSuccess, ApiError } from '@/types';

export interface FetchOptions extends RequestInit {
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Set true for POST/PATCH/DELETE — `apiFetch` will automatically
   * attach the `X-CSRF-Token` header from the XSRF-TOKEN cookie.
   * The header is required by `csrfMiddleware` in the backend.
   */
  isMutation?: boolean;
}

// NOTE: FetchTimeoutError was previously defined here but was dead code —
// the timeout mechanism uses AbortController.abort() which causes fetch to
// reject with DOMException (name: 'AbortError'), not FetchTimeoutError.
// No code in the codebase ever caught FetchTimeoutError. Removed to prevent
// misleading future maintainers. Use isCancelError() to detect aborted requests.

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Race two abort signals together - returns a signal that aborts when either aborts
 * Properly cleans up listeners when either fires
 */
function signalRace(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  // Handle pre-aborted signals: if either signal is already aborted,
  // immediately abort the combined signal. Otherwise addEventListener
  // would never fire the abort event.
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  let fired = false;

  const cleanup = () => {
    if (!fired) {
      fired = true;
      a.removeEventListener('abort', aHandler);
      b.removeEventListener('abort', bHandler);
    }
  };

  const aHandler = () => {
    cleanup();
    controller.abort();
  };
  const bHandler = () => {
    cleanup();
    controller.abort();
  };

  a.addEventListener('abort', aHandler);
  b.addEventListener('abort', bHandler);

  return controller.signal;
}

/**
 * Combine external signal with internal timeout controller
 * Ensures proper cleanup of event listeners
 */
function combineSignals(externalSignal: AbortSignal | undefined, timeoutController: AbortController): AbortSignal {
  if (!externalSignal) {
    return timeoutController.signal;
  }

  const combined = signalRace(externalSignal, timeoutController.signal);
  return combined;
}

/**
 * Build the request headers, attaching `X-CSRF-Token` automatically on
 * mutating methods. The token is read from the XSRF-TOKEN cookie that the
 * server sets on login. If the cookie is missing, we still send the request
 * — the backend will return 403 and the caller can handle it. We never
 * *block* the request just because the cookie is missing, because the
 * user might be in a partially-set-up state (e.g. mid-login) and the
 * backend's 403 is the source of truth.
 */
function buildHeaders(options: FetchOptions, baseHeaders: Record<string, string>): Record<string, string> {
  const method = (options.method ?? 'GET').toUpperCase();
  const out: Record<string, string> = { ...baseHeaders };
  // Fix: Only attach CSRF token for actual mutating methods (POST/PUT/PATCH/DELETE),
  // NOT just when isMutation is set. Previously, passing isMutation: true with a
  // GET request would attach the X-CSRF-Token header on every GET, leaking the
  // token unnecessarily. The token should only be sent when the method itself is
  // mutating — the backend csrfMiddleware rejects non-mutation requests anyway.
  if (MUTATION_METHODS.has(method)) {
    const token = readCookie(CSRF_COOKIE_NAME);
    if (token) out[CSRF_HEADER] = token;
  }
  return out;
}

export interface ApiFetchHandle<T> {
  promise: Promise<ApiResponse<T>>;
  cancel: () => void;
}

export function apiFetch<T>(
  url: string,
  options: FetchOptions = {}
): Promise<ApiResponse<T>> {
  // For backwards compatibility, return the promise directly. The cancel
  // capability is exposed via apiFetchWithCancel for callers that need it.
  return apiFetchWithCancel<T>(url, options).promise;
}

/**
 * Like apiFetch but returns a `{ promise, cancel }` pair. Callers that
 * may need to abort an in-flight request (e.g. on a new generation start)
 * should prefer this over the plain `apiFetch`. The cancel function
 * aborts the underlying fetch — the promise rejects with an `AbortError`.
 */
export function apiFetchWithCancel<T>(
  url: string,
  options: FetchOptions = {}
): ApiFetchHandle<T> {
  const { timeout = 30000, signal: externalSignal, ...fetchOptions } = options;
  const normalizedApiBase = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const normalizedUrl = API_BASE && url.startsWith(API_BASE)
    ? normalizedApiBase + url.slice(API_BASE.length)
    : url;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);
  const combinedSignal = combineSignals(externalSignal, timeoutController);

  // JWT cookie is sent automatically with credentials: 'include'
  const promise = fetch(normalizedUrl, {
    ...fetchOptions,
    signal: combinedSignal,
    credentials: 'include',
    headers: buildHeaders(options, {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers as Record<string, string> | undefined),
    }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // If the backend returned a structured JSON error, return it as a
        // normal ApiResponse so callers get the real error message instead
        // of a generic catch-block fallback.
        try {
          const parsed = JSON.parse(errorText);
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            // M3: Preserve the HTTP status on structured error bodies so callers
            // can tell a genuine auth failure (401) from a transient 5xx.
            // Previously the status was dropped, collapsing both into the same
            // { success:false } shape (this masked the auth-context logout bug).
            return { success: false, error: parsed.error, statusCode: response.status } as unknown as ApiResponse<T>;
          }
        } catch {
          // Not JSON — fall through to throw.
        }
        throw new ApiRequestError(
          `Request failed with status ${response.status}`,
          response.status,
          errorText
        );
      }
      // Fix: Handle non-JSON responses gracefully. Previously, if the backend
      // returned a non-JSON response (e.g. an HTML error page, empty 204, or
      // redirect), response.json() would throw SyntaxError with no helpful
      // context. Now we check Content-Type first; if it's not JSON, we return
      // a fallback object so callers don't crash.
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !contentType.includes('application/problem+json')) {
        // Non-JSON response — return a generic success/error based on status
        const text = await response.text().catch(() => '');
        if (response.ok) {
          return { success: true, data: text } as unknown as ApiResponse<T>;
        }
        return { success: false, error: text || `HTTP ${response.status}` } as ApiResponse<T>;
      }
      return response.json() as Promise<ApiResponse<T>>;
    })
    .finally(() => clearTimeout(timeoutId));

  return {
    promise,
    cancel: () => timeoutController.abort(),
  };
}

/**
 * Create an AbortController that can be used to cancel requests
 */
export function createCancelToken(): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: () => controller.abort(),
  };
}

/**
 * Check if an error is from a cancelled request
 */
export function isCancelError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.message.includes('aborted') ||
    error.message.includes('cancel')
  );
}

/**
 * Like apiFetch but returns the raw Response so callers can handle
 * binary bodies (e.g. file downloads via .blob()).
 */
export function apiRawFetch(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { timeout = 30000, signal: externalSignal, ...fetchOptions } = options;
  const normalizedApiBase = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const normalizedUrl = API_BASE && url.startsWith(API_BASE)
    ? normalizedApiBase + url.slice(API_BASE.length)
    : url;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeout);
  const combinedSignal = combineSignals(externalSignal, timeoutController);

  return fetch(normalizedUrl, {
    ...fetchOptions,
    signal: combinedSignal,
    credentials: 'include',
    headers: buildHeaders(options, {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers as Record<string, string> | undefined),
    }),
  }).finally(() => clearTimeout(timeoutId));
}
