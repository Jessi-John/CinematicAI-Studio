/**
 * Runtime configuration module.
 *
 * Determines the API base URL for all backend requests. The primary mode
 * routes through Next.js API routes (BFF) on the same origin, avoiding CORS
 * and keeping backend URLs internal. A direct Express URL is used only when
 * Next.js API routes are unavailable (standalone Express deployment).
 *
 * Resolution order:
 * 1. `window.__RUNTIME_CONFIG__.API_BASE_URL` — injected at Docker container
 *    start time by `scripts/docker-entrypoint.sh` via `public/runtime-config.js`.
 * 2. `process.env.NEXT_PUBLIC_API_URL` — Next.js build-time env var.
 * 3. Empty string (same-origin, BFF proxy mode) — default when running
 *    through Next.js dev server or production build.
 *
 * When API_BASE is empty (BFF mode), all fetch calls use relative URLs
 * like `/api/stories/generate`, which are caught by the Next.js API route
 * proxy at `app/api/[...path]/route.ts` and forwarded to Express.
 */

const DEFAULT_API_BASE = '';

function resolveApiBase(): string {
  if (typeof window !== 'undefined') {
    const rc = (window as unknown as { __RUNTIME_CONFIG__?: { API_BASE_URL?: string } }).__RUNTIME_CONFIG__;
    if (rc?.API_BASE_URL) {
      return rc.API_BASE_URL;
    }
  }
  return process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE;
}

const resolved = resolveApiBase();
export const API_BASE: string = resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;

/**
 * Resolved Express backend URL for the Next.js API route proxy.
 * Only read at build/runtime time on the server side.
 */
export const PROXY_TARGET: string = process.env.API_BASE_URL || DEFAULT_API_BASE || 'http://localhost:34567';
