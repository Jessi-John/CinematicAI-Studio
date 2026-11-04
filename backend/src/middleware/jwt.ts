/**
 * JWT helpers and middleware for cookie-based authentication.
 *
 * Tokens are HS256-signed, stored in httpOnly, SameSite=strict cookies.
 * No CSRF risk with SameSite=strict — cross-site requests never send the cookie.
 *
 * SEC-003: Token blacklist on logout. Every JWT carries a unique `jti` (JWT ID)
 * field. When a user logs out, the jti is stored in Redis with a TTL matching
 * the token's remaining expiry. The jwtMiddleware checks this blacklist on every
 * authenticated request, so a logged-out token cannot be reused even within its
 * 15-minute expiry window. The blacklist is stored as:
 *   key:   `token_blacklist:{jti}`
 *   value: `1`
 *   TTL:   remaining seconds until token expiry
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { getJwtSecret, allowInsecureLocalHttp, isProduction, e2eTestBypassEnabled } from '../config/env.js';
import { getSharedRedis } from '../lib/shared-redis.js';

export const JWT_COOKIE = 'access_token';
export const JWT_EXPIRY = '15m';

export interface JwtPayload {
  jti: string;   // unique JWT ID for blacklist
  sub: string;   // user id
  username: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  secure: boolean;
  path: string;
}

export const JWT_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  // ALLOW_INSECURE_LOCAL_HTTP: local Docker Compose stacks often do not
  // terminate TLS. A Secure cookie would be withheld by the browser over plain
  // HTTP, breaking cookie-authenticated requests. This flag is opt-in and must
  // never be enabled in production.
  secure:
    isProduction() &&
    !e2eTestBypassEnabled() &&
    !allowInsecureLocalHttp(),
  path: '/',
};

/**
 * Generate a unique JWT ID for token blacklisting.
 * Uses 16 bytes of randomness formatted as 32 hex chars.
 */
export function generateJti(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>): string {
  const jti = generateJti();
  return jwt.sign({ ...payload, jti }, getJwtSecret(), { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return null;
    if (!decoded.jti || !decoded.sub || !decoded.username || !decoded.role) return null;
    return decoded as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * SEC-003: Blacklist a JWT by its jti so it cannot be reused.
 * The blacklist entry in Redis has a TTL matching the token's remaining
 * validity window. This ensures the blacklist is self-cleaning — expired
 * tokens are automatically evicted from Redis and don't accumulate.
 *
 * @param payload The decoded JWT payload (must have jti field).
 * @returns Promise that resolves when the blacklist entry is set.
 */
export async function blacklistToken(payload: JwtPayload): Promise<void> {
  if (!payload.jti) return;
  try {
    const redis = getSharedRedis();
    // Calculate remaining TTL: exp - current time + 60s grace period
    // The +60s grace prevents race conditions where a token is used just
    // before its exp boundary and the computed TTL rounds to 0.
    const remaining = payload.exp
      ? Math.max(60, payload.exp - Math.floor(Date.now() / 1000) + 60)
      : 900 + 60; // default 15m + 60s grace
    await redis.setex(`token_blacklist:${payload.jti}`, remaining, '1');
  } catch (err) {
    // Blacklisting is mandatory in production. If Redis is down, the token
    // remains valid until expiry, which would allow a logged-out user to
    // keep accessing the app. Fail closed by returning 503 so the client
    // can retry. In dev/test, log a warning and continue.
    if (isProduction()) {
      throw Object.assign(new Error('Token blacklist unavailable'), { code: 'BLACKLIST_UNAVAILABLE' });
    }
    const { logger } = await import('../services/logger.js');
    logger.warn({ err }, 'Failed to blacklist JWT token');
  }
}

/**
 * SEC-003: Check if a JWT has been blacklisted.
 * Returns true if the token's jti is in the Redis blacklist.
 *
 * @param payload The decoded JWT payload (must have jti field).
 * @returns true if the token has been blacklisted (logged out).
 */
export async function isTokenBlacklisted(payload: JwtPayload): Promise<boolean> {
  if (!payload.jti) return false;
  try {
    const redis = getSharedRedis();
    const exists = await redis.exists(`token_blacklist:${payload.jti}`);
    return exists === 1;
  } catch {
    // MEDIUM #33: Fail-closed in production. Allowing blacklisted tokens
    // through during a Redis outage grants access to logged-out/banned users
    // until the token's natural expiry. In non-production, fail-open so a
    // local Redis blip does not block development.
    if (isProduction()) {
      throw Object.assign(new Error('Token blacklist unavailable'), { code: 'BLACKLIST_UNAVAILABLE' });
    }
    return false;
  }
}

export async function jwtMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Auth routes (/auth/*) don't require authentication.
  // req.path is relative to the /api mount point.
  if (req.path.startsWith('/auth/')) {
    next();
    return;
  }

  // Admin routes use ADMIN_API_KEY or their own JWT verification
  // (verifyAdminAuth). Skip jwtMiddleware so admin API keys are not
  // rejected by the JWT signature check. verifyAdminAuth independently
  // handles Bearer JWT tokens for admin roles.
  if (req.path.startsWith('/admin/')) {
    next();
    return;
  }

  // OpenAPI docs are admin-only but authenticated via ADMIN_API_KEY or admin
  // JWT (verified by verifyAdminAuth), not the standard JWT middleware.
  if (req.path.startsWith('/docs/') || req.path === '/docs') {
    next();
    return;
  }

  // Generation auth endpoints use HMAC-signed query-string auth in eventsRouter
  // (see api-auth.ts and events.ts). Skip cookie JWT here so the HMAC check can
  // run. /events is HMAC-only; /status and /refresh-auth accept either HMAC or
  // JWT, so we only skip jwtMiddleware when HMAC credentials are supplied.
  // REL-008/REL-011: Without this skip, HMAC-signed requests would 401 in
  // jwtMiddleware before reaching eventsRouter.
  const ssePath = (req.originalUrl ?? '').split('?')[0]!;
  // M22: prefix-agnostic — routes are mounted under BOTH /api and /api/v1,
  // and the hard-coded /api-only regex made the documented HMAC flow 401 on
  // the /api/v1 mount (fail-closed, but broken).
  const generationAuthMatch = /^\/api(?:\/v\d+)?\/stories\/generate\/[^/]+\/(events|status|refresh-auth)$/.exec(ssePath);
  if (generationAuthMatch) {
    const endpoint = generationAuthMatch[1];
    if (endpoint === 'events') {
      next();
      return;
    }
    const hasHmac = typeof req.query.auth === 'string' && typeof req.query.t === 'string';
    if (hasHmac) {
      next();
      return;
    }
  }

  // Accept token from either cookie or Authorization header (Bearer scheme).
  // Cookie takes precedence when both are present, matching the auth route
  // handlers and ensuring an ambient browser cookie is not overridden by an
  // attacker-controlled Authorization header on the same request.
  // JWT_SECURE: only accept secure cookies over HTTPS in production.
  // E2E_TEST bypass: Playwright E2E specs run against the local Docker stack
  // over plain HTTP (localhost). Requiring HTTPS would make every cookie-auth
  // request fail, so we skip the transport check in that mode.
  // ALLOW_INSECURE_LOCAL_HTTP: local Docker Compose stacks may also run over
  // plain HTTP. Opt-in only; production deployments still require HTTPS or a
  // trusted TLS-terminating reverse proxy that sets x-forwarded-proto: https.
  const forwardedProto = req.headers['x-forwarded-proto'];
  const isSecure = typeof forwardedProto === 'string' ? forwardedProto.startsWith('https') : false;
  const isE2E = e2eTestBypassEnabled();
  const isLocalHttpAllowed = allowInsecureLocalHttp();
  if (isProduction() && !isE2E && !isLocalHttpAllowed && !req.secure && !isSecure) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const cookieToken = req.cookies[JWT_COOKIE] ?? null;
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const token = cookieToken || headerToken;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // SEC-003: Check if this token has been blacklisted (user logged out).
  // The blacklist check runs after JWT verification so we only hit Redis
  // for tokens that are structurally valid — invalid tokens are rejected
  // early without a Redis round-trip.
  try {
    const blacklisted = await isTokenBlacklisted(payload);
    if (blacklisted) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'BLACKLIST_UNAVAILABLE') {
      res.status(503).json({ error: 'Authentication service temporarily unavailable' });
      return;
    }
    throw err;
  }

  req.user = payload;
  next();
}