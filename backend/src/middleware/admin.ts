import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getAdminApiKey, getApiSecret } from '../config/env.js';
import { verifyToken, JWT_COOKIE, isTokenBlacklisted, type AuthenticatedRequest } from './jwt.js';
import type { ApiResponse } from '../services/types.js';

/**
 * Middleware to verify admin authentication.
 *
 * Admin routes accept two authentication methods:
 * 1. ADMIN_API_KEY in Bearer token (server-to-server/scripts)
 * 2. Valid JWT with role='admin' (user-level admin)
 *
 * API_SECRET never grants admin access (privilege separation, SEC-004).
 */

// Timing-safe comparison to prevent timing attack enumeration of admin keys.
// HMAC both inputs so the comparison is always done on fixed-length digests
// and never leaks the length of the raw admin key.
function adminKeyDigest(key: string): Buffer {
  return crypto.createHmac('sha256', getApiSecret()).update(key).digest();
}

function timingSafeEqual(a: string, b: string): boolean {
  const digestA = adminKeyDigest(a);
  const digestB = adminKeyDigest(b);
  return crypto.timingSafeEqual(digestA, digestB);
}

export async function verifyAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authReq = req as AuthenticatedRequest;

  // Method 1: jwtMiddleware has already verified a JWT (cookie or Bearer)
  // and attached the user. This covers routes like /api/settings that run
  // after jwtMiddleware.
  if (authReq.user?.role === 'admin') {
    next();
    return;
  }

  // Method 2: ADMIN_API_KEY Bearer header. This must work even when a
  // non-admin JWT cookie is also present, so it is checked before rejecting
  // based on the JWT role.
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length);
    const adminKey = getAdminApiKey();
    if (timingSafeEqual(adminKey, token)) {
      next();
      return;
    }
    // HIGH-5: Try Bearer JWT verification — an admin user may send a JWT
    // token instead of the admin API key. Without this, Bearer JWTs on
    // admin routes are rejected because jwtMiddleware skips /admin/*.
    const jwtPayload = verifyToken(token);
    if (jwtPayload?.role === 'admin') {
      try {
        if (await isTokenBlacklisted(jwtPayload)) {
          res.status(401).json({ success: false, error: 'Token has been revoked' } satisfies ApiResponse<null>);
          return;
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'BLACKLIST_UNAVAILABLE') {
          res.status(503).json({ success: false, error: 'Authentication service temporarily unavailable' } satisfies ApiResponse<null>);
          return;
        }
        throw err;
      }
      next();
      return;
    }
    // Bearer present but wrong — do not fall through to other methods.
    res.status(403).json({ success: false, error: 'Invalid admin API key' } satisfies ApiResponse<null>);
    return;
  }

  // Method 3: JWT cookie/session for admin role. Used by /api/admin routes,
  // which skip jwtMiddleware.
  const cookieToken = req.cookies?.[JWT_COOKIE];
  if (cookieToken) {
    const payload = verifyToken(cookieToken);
    if (payload?.role === 'admin') {
      // H12: Check JWT blacklist — a logged-out admin's token (jti blacklisted
      // via /api/auth/logout) was still valid for admin operations for up to
      // 15 min. jwtMiddleware is explicitly skipped for /admin routes, so
      // there was no other blacklist check on the admin path.
      try {
        if (await isTokenBlacklisted(payload)) {
          res.status(401).json({ success: false, error: 'Token has been revoked' } satisfies ApiResponse<null>);
          return;
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'BLACKLIST_UNAVAILABLE') {
          res.status(503).json({ success: false, error: 'Authentication service temporarily unavailable' } satisfies ApiResponse<null>);
          return;
        }
        throw err;
      }
      next();
      return;
    }
    // Authenticated via cookie but not an admin.
    if (payload) {
      res.status(403).json({ success: false, error: 'Admin access required' } satisfies ApiResponse<null>);
      return;
    }
  }

  // No admin credential of any kind.
  res.status(401).json({ success: false, error: 'Missing admin authorization' } satisfies ApiResponse<null>);
}
