/**
 * Server-side CSRF validation + token issuance.
 *
 * The middleware enforces a strict double-submit pattern:
 *   - The server issues a CSRF token by setting a non-httpOnly `XSRF-TOKEN`
 *     cookie on every mutating response (or on first auth).
 *   - The client reads the cookie via `document.cookie` and echoes the
 *     value in the `X-CSRF-Token` header on every mutating request.
 *   - The server validates the header is present, is a 64-char hex
 *     string, AND matches the XSRF-TOKEN cookie value. The cookie is
 *     SameSite=Strict (never sent cross-origin), so an attacker on a
 *     different origin cannot read or forge it. This is the standard
 *     double-submit pattern.
 *
 * Fix #8: Scope the XSRF-TOKEN cookie strictly. The previous code path
 *   set the cookie with no path/secure/sameSite, so it was visible to
 *   every request to the API host. We now set:
 *     - `path: '/'`  (the cookie is needed for every API route)
 *     - `sameSite: 'strict'` (never sent on cross-origin navigations)
 *     - `secure` in production (HTTPS-only)
 *   and we ensure the value is `httpOnly: false` so the browser-side
 *   `document.cookie` can read it.
 *
 * Routes exempt from CSRF:
 *   - GET, HEAD, OPTIONS — safe methods
 *   - /api/health — health check works without auth/CSRF
 *   - /api/metrics — Prometheus uses GET
 *   - /api/auth/* — login itself cannot require a CSRF token (chicken/egg)
 *   - SSE endpoint — uses HMAC-signed URL auth instead
 *
 * Usage in server.ts:
 *   import { csrfMiddleware, issueCsrfCookie } from './middleware/csrf.js';
 *   app.use('/api', csrfMiddleware);
 *   app.use('/api/auth', issueCsrfCookie); // issue token on auth responses
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { allowInsecureLocalHttp, isProduction, e2eTestBypassEnabled } from '../config/env.js';

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE_NAME = 'XSRF-TOKEN';
const CSRF_HEADER_LENGTH = 64; // 256-bit token encoded as 64 hex chars

/**
 * Read a cookie value from the raw Cookie header string.
 * This works regardless of whether cookie-parser middleware is installed,
 * making the CSRF middleware self-contained and testable.
 */
function readCookieFromHeader(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const target = `${name}=`;
  for (const part of cookies.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      return decodeURIComponent(trimmed.slice(target.length));
    }
  }
  return undefined;
}

// Exposed as a named constant so tests can pin the canonical exempt list. Any
// new route added to this list MUST be reflected here, and any new route
// considered for exemption MUST be reviewed against this list.
export const CSRF_EXEMPT_PATHS: ReadonlyArray<string> = ['/health', '/metrics'];

// Mutation methods that require CSRF protection. Exported for tests.
export const CSRF_MUTATION_METHODS: ReadonlyArray<string> = ['POST', 'PUT', 'PATCH', 'DELETE'];

function isMutation(req: Request): boolean {
  // PUT must be in this list. The previous version omitted it, which meant
  // every PUT endpoint (PUT /api/settings/:key, PUT /api/user-settings/:key,
  // PUT /api/admin/settings/pipeline/:key, etc.) skipped CSRF protection
  // entirely — a CSRF attacker could mutate user or system settings from
  // a victim's browser.
  return CSRF_MUTATION_METHODS.includes(req.method.toUpperCase());
}

function isExemptPath(path: string): boolean {
  // Strip the /api prefix so the same check works whether the path is the
  // mount-relative req.path (e.g. "/health") or the full originalUrl-style
  // path (e.g. "/api/health").
  const p = path.startsWith('/api') ? path.slice(4) || '/' : path;
  return CSRF_EXEMPT_PATHS.some((exempt) => p === exempt || p.startsWith(`${exempt}/`));
}

function isAuthPath(path: string): boolean {
  // /api/auth/* is exempt from CSRF on the SERVER side because the
  // initial login must be possible without a token (chicken/egg). The
  // login response sets the XSRF-TOKEN cookie, so subsequent mutating
  // requests DO have a token to echo back.
  const p = path.startsWith('/api') ? path.slice(4) || '/' : path;
  return p === '/auth' || p.startsWith('/auth/');
}

function isSSEPath(path: string): boolean {
  // Accept both the mount-relative form ("/stories/generate/.../events")
  // and the full form ("/api/stories/.../events").
  // M22: the full form also exists under /api/v1.
  const p = path.startsWith('/api') ? path.slice(4) : path;
  return /^(?:\/v\d+)?\/stories\/generate\/[^/]+\/events$/.test(p);
}

function isValidHexToken(token: string): boolean {
  return token.length === CSRF_HEADER_LENGTH && /^[a-fA-F0-9]{64}$/.test(token);
}

/** Generate a new 64-char hex CSRF token (256 bits of entropy). */
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Set the XSRF-TOKEN cookie on the response. The cookie is non-httpOnly
 * because the double-submit pattern requires the client to read it via
 * `document.cookie`. The cookie is `sameSite: 'strict'` so it never
 * travels on cross-origin requests (the most common CSRF vector).
 *
 * Fix #8: every setting now explicitly scoped. The previous version
 * set no path, so the cookie was visible to every route on the host
 * (including non-API paths that have no use for it).
 */
// CSRF token lifetime: 24 hours. The token is rotated on every login/refresh,
// so a leaked token has a bounded window of validity.
const CSRF_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // required for the double-submit pattern
    // ALLOW_INSECURE_LOCAL_HTTP: local Docker Compose stacks often do not
    // terminate TLS (frontend/backend communicate over the Docker network).
    // A Secure cookie would be withheld by the browser over plain HTTP, so
    // CSRF double-submit validation would fail. Production MUST NOT enable this.
    secure:
      isProduction() &&
      !e2eTestBypassEnabled() &&
      !allowInsecureLocalHttp(),
    sameSite: 'strict',
    path: '/', // every /api/* route may mutate
    maxAge: CSRF_TOKEN_MAX_AGE_MS,
  });
}

/**
 * Middleware that issues a fresh XSRF-TOKEN cookie on every response
 * from /api/auth/*. Mount this on the auth router so the client always
 * has a token to echo back for subsequent mutating requests.
 */
export function issueCsrfCookie(_req: Request, res: Response, next: NextFunction): void {
  if (!res.headersSent) {
    const existingCookies = res.getHeader('Set-Cookie');
    const hasXsrfCookie = Array.isArray(existingCookies)
      ? existingCookies.some((c) => typeof c === 'string' && c.startsWith('XSRF-TOKEN='))
      : typeof existingCookies === 'string' && existingCookies.startsWith('XSRF-TOKEN=');
    if (!hasXsrfCookie) {
      setCsrfCookie(res, generateCsrfToken());
    }
  }
  next();
}

export function csrfMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Only apply to /api routes. The middleware is mounted at /api so req.path
  // is relative to that mount — use req.baseUrl to recover the full prefix.
  // (SEC-CRITICAL: req.path.startsWith('/api') is always false here, which
  // previously disabled CSRF protection entirely.)
  const fullPath = req.baseUrl + req.path;
  if (!fullPath.startsWith('/api')) {
    next();
    return;
  }

  // Safe methods and exempt routes never need CSRF
  // Auth paths are handled by the dedicated issueCsrfCookie middleware
  // mounted on /api/auth in server.ts, which runs before the auth router.
  // We do NOT re-issue the cookie here to avoid duplicate Set-Cookie headers.
  if (
    !isMutation(req) ||
    isExemptPath(fullPath) ||
    isAuthPath(fullPath) ||
    isSSEPath(fullPath)
  ) {
    next();
    return;
  }

  // SEC-CRITICAL: Skip CSRF for admin/API-key routes that use Bearer tokens.
  // Bearer tokens are not vulnerable to CSRF because browsers do not
  // automatically attach Authorization headers on cross-origin requests. We
  // scope the exemption strictly to admin paths (/api/admin/* and
  // /api/settings/*) and OpenAPI docs (/api/docs/*) so a
  // coincidental/attacker-controlled Authorization header cannot bypass CSRF
  // for a cookie-authenticated non-admin request.
  const authHeader = req.headers.authorization;
  const path = req.path || '/';
  const isAdminPath = path.startsWith('/admin/') || path.startsWith('/settings/') || path.startsWith('/docs/');
  if (isAdminPath && authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const headerToken = req.headers[CSRF_HEADER] as string | undefined;
  const cookieToken = readCookieFromHeader(req, CSRF_COOKIE_NAME);

  if (!headerToken) {
    res.status(403).json({ error: 'X-CSRF-Token header missing — requests require this header on all mutating operations' });
    return;
  }

  if (typeof headerToken !== 'string' || !isValidHexToken(headerToken)) {
    res.status(403).json({ error: 'Invalid X-CSRF-Token — must be a 64-char hex string' });
    return;
  }

  // SEC-CRITICAL: True double-submit pattern enforcement.
  // The XSRF-TOKEN cookie (non-httpOnly, SameSite=Strict) is set by the
  // server on the real origin. Client-side JS reads it via document.cookie
  // and echoes the value in the X-CSRF-Token header. An attacker on a
  // different origin cannot read the victim's cookie, so they cannot set
  // the correct header value.
  //
  // We compare the header value against the cookie value. A mismatch means
  // the client does not have access to the real cookie — reject the request.
  // This is the standard double-submit pattern. Previous versions only
  // validated header format (not value), which provided zero additional
  // protection beyond SameSite=Strict.
  if (!cookieToken) {
    res.status(403).json({ error: 'XSRF-TOKEN cookie missing — required for CSRF validation' });
    return;
  }

  // L6: timing-safe comparison on digests (mirrors admin.ts) — a plain
  // string compare leaks prefix correctness via response timing.
  const headerDigest = crypto.createHmac('sha256', 'csrf').update(String(headerToken)).digest();
  const cookieDigest = crypto.createHmac('sha256', 'csrf').update(String(cookieToken)).digest();
  if (headerDigest.length !== cookieDigest.length || !crypto.timingSafeEqual(headerDigest, cookieDigest)) {
    res.status(403).json({ error: 'X-CSRF-Token header does not match XSRF-TOKEN cookie — possible CSRF attack' });
    return;
  }

  next();
}
