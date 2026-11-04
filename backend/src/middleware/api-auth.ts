/**
 * API authentication middleware.
 *
 * Handles SSE auth verification. SSE endpoints support TWO auth methods:
 * 1. JWT cookie auth (primary) — EventSource automatically sends the httpOnly cookie
 * 2. HMAC query param auth (legacy fallback) — for clients that can preserve query params
 *
 * All other /api/* routes use jwtMiddleware for cookie-based JWT authentication.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { getApiSecret } from '../config/env.js';
import { logger } from '../services/logger.js';
import { verifyToken, JWT_COOKIE } from './jwt.js';
import { userOwnsJob } from '../lib/job-ownership.js';

const SSE_AUTH_TIMESTAMP_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SSE_AUTH_CLOCK_SKEW_MS = 5_000;
const HEX_REGEX = /^[0-9a-f]{64}$/i;

export function isSSEPath(originalUrl: string | undefined): boolean {
  const path = (originalUrl ?? '').split('?')[0]!;
  // M22: accept both /api and /api/v1 mounts.
  return /^\/api(?:\/v\d+)?\/stories\/generate\/[^/]+\/events$/.test(path);
}

export function verifySSEAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.query.auth;
  const t = req.query.t;

  // L8: try the JWT cookie FIRST when present — a cookie-authenticated
  // EventSource URL without auth/t query params must not 401. The non-string
  // param check only applies to the HMAC path below.
  const cookieToken = req.cookies[JWT_COOKIE] ?? null;

  // Reject array or non-string query parameters ONLY when they are present
  // and malformed; absence is fine when the JWT cookie authenticates.
  const paramsPresent = auth !== undefined || t !== undefined;
  if (paramsPresent && (typeof auth !== 'string' || typeof t !== 'string') && !cookieToken) {
    logger.warn({ path: req.path }, 'SSE request with non-string auth parameters');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Method 1: JWT cookie auth (primary — EventSource sends cookie automatically).
  // If the cookie is valid, authenticate immediately. If it's expired/malformed,
  // fall through to HMAC check instead of rejecting — this handles reconnections
  // that happen after the 15-minute JWT TTL but within the 2-hour HMAC TTL.
  if (cookieToken) {
    const payload = verifyToken(cookieToken);
    if (payload) {
      // H1: A valid JWT alone must NOT grant access to another user's job
      // stream. Enforce that the token's subject owns this jobId before
      // allowing the SSE subscription. Fail closed on any error or unknown
      // ownership so a job of unknown owner is never exposed.
      const jobId = String(req.params.jobId ?? '');
      void (async (): Promise<void> => {
        try {
          if (jobId.length > 0 && (await userOwnsJob(jobId, payload.sub))) {
            logger.info({ jobId }, 'SSE authenticated via JWT cookie');
            next();
            return;
          }
          logger.warn({ jobId, userId: payload.sub }, 'SSE JWT ownership check failed');
          res.status(403).json({ error: 'Forbidden' });
        } catch (err) {
          logger.warn({ jobId, err: String(err) }, 'SSE ownership check error');
          res.status(403).json({ error: 'Forbidden' });
        }
      })();
      return;
    }
    logger.warn({ path: req.path }, 'SSE request with expired JWT cookie — falling through to HMAC');
  }

  // Method 2: HMAC query param auth (legacy fallback for clients that preserve query params)
  if (!auth || !t) {
    logger.warn({ path: req.path }, 'SSE request missing auth parameters (no cookie, no HMAC params)');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const age = Date.now() - timestamp;
  if (age > SSE_AUTH_TIMESTAMP_TTL_MS || age < -SSE_AUTH_CLOCK_SKEW_MS) {
    logger.warn({ path: req.path, age }, 'SSE request timestamp expired');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const urlPath = (req.originalUrl ?? '').split('?')[0]!;
  const match = urlPath.match(/^\/api(?:\/v\d+)?\/stories\/generate\/([^/]+)\/events$/);
  if (!match) {
    logger.warn({ path: req.path }, 'verifySSEAuth: path regex no match');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const jobId = match[1]!;

  // Narrow the HMAC inputs to strings before use (query params can be arrays).
  if (typeof auth !== 'string' || typeof t !== 'string') {
    logger.warn({ path: req.path }, 'SSE request with non-string auth parameters');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = `${jobId}:${t}`;
  const expectedSig = crypto
    .createHmac('sha256', getApiSecret())
    .update(payload)
    .digest('hex');

  if (!HEX_REGEX.test(auth)) {
    logger.warn({ path: req.path }, 'SSE request auth parameter is not valid hex');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const authBuffer = Buffer.from(auth, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  // timingSafeEqual throws if lengths differ — reject with 401 instead of 500
  if (authBuffer.length !== expectedBuffer.length) {
    logger.warn({ path: req.path }, 'SSE auth length mismatch');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!crypto.timingSafeEqual(authBuffer, expectedBuffer)) {
    logger.warn({ path: req.path }, 'SSE request with invalid HMAC signature');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  logger.info({ jobId }, 'SSE HMAC verified OK');

  next();
}

/**
 * Verify an HMAC signature is valid for a specific jobId.
 * Used by refresh-auth to verify the client knows the current auth before
 * issuing a new HMAC-signed URL.
 */
export async function verifySSEAuthForJob(
  jobId: string,
  auth: string,
  t: string
): Promise<boolean> {
  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) return false;

  const age = Date.now() - timestamp;
  if (age > SSE_AUTH_TIMESTAMP_TTL_MS || age < -SSE_AUTH_CLOCK_SKEW_MS) return false;

  if (!HEX_REGEX.test(auth)) return false;

  const payload = `${jobId}:${t}`;
  const expectedSig = crypto
    .createHmac('sha256', getApiSecret())
    .update(payload)
    .digest('hex');

  const authBuffer = Buffer.from(auth, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  if (authBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(authBuffer, expectedBuffer);
}

export function apiAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.path === '/health' || req.path.startsWith('/health/')) {
    next();
    return;
  }

  if (isSSEPath(req.originalUrl)) {
    next();
    return;
  }

  // All other /api routes pass through — jwtMiddleware handles auth.
  // Auth routes (/api/auth/*) are handled by authRouter directly.
  next();
}