/**
 * Authentication routes: login, logout, me, refresh.
 *
 * Uses JWT in httpOnly, SameSite=strict cookie for the session.
 * The CSRF token (XSRF-TOKEN cookie) is set on every successful login and
 * refresh — the client reads it and echoes it in the X-CSRF-Token header
 * for subsequent mutating requests. See middleware/csrf.ts for details.
 *
 * Mounted at /api/auth — all paths here are relative to that prefix.
 * Login and register themselves are exempt from CSRF (chicken/egg) but
 * the response sets the XSRF-TOKEN cookie so the *next* request is
 * protected.
 *
 * Fix #47: every body parameter is validated by Zod. The previous version
 * did manual `req.body.username` reads with a hand-written length check,
 * which would silently accept anything else in the body (extra fields,
 * wrong types) and surface as a confusing `bcrypt.hash(undefined, ...)`
 * error. Zod's `.strict()` mode rejects unknown fields so a typo in a
 * client request fails loudly with a precise error message.
 */

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { signToken, verifyToken, blacklistToken, isTokenBlacklisted, JWT_COOKIE, JWT_COOKIE_OPTIONS } from '../middleware/jwt.js';
import { setCsrfCookie, generateCsrfToken } from '../middleware/csrf.js';
import { prisma } from '../database/prisma.js';
import { logger } from '../services/logger.js';
import { isRegistrationDisabled, getInviteCode, shouldBootstrapFirstUserAsAdmin } from '../config/env.js';
import { asyncHandler } from '../middleware/error.js';

// Lazy getter so the env value is read after validateAndLoadEnv() completes.
// The bcrypt rounds default is 12, matching the fallback hash hardcoded
// in getDummyHash's catch block. This is read lazily both here and in the
// register handler — the getter is safe to call multiple times.
function getBcryptRounds(): number {
  const raw = process.env.BCRYPT_ROUNDS ?? '12';
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 10 || parsed > 14) {
    logger.warn({ raw }, 'BCRYPT_ROUNDS out of safe bounds (10-14); using default 12');
    return 12;
  }
  return parsed;
}

// Fix LOW-2 + MED-27: Pre-computed dummy bcrypt hash used for constant-time login
// comparison. When a login attempt targets a non-existent user, we compare
// the password against this hash instead of short-circuiting — eliminating
// the ~200ms timing difference that would otherwise reveal valid usernames.
// This is computed lazily to avoid blocking the event loop at module load time
// (bcrypt.hashSync with 12 rounds takes ~237ms synchronously).
let _dummyHashPromise: Promise<string> | null = null;
async function getDummyHash(): Promise<string> {
  if (!_dummyHashPromise) {
    _dummyHashPromise = bcrypt.hash('__constant_time_dummy__', getBcryptRounds()).catch(() =>
      '$2b$12$.ZamHq3QtuSnAGtBFfJS3.TxLVxBkeYneFapCgm3UM/Fvv.BmBN6i'
    );
  }
  return _dummyHashPromise;
}

export const authRouter = Router();

// Fix #47: Zod schemas for the auth body payloads.
// Exported for use in openapi.ts (Fix #26) to generate OpenAPI spec from Zod schemas.
export const credentialsSchema = z
  .object({
    username: z
      .string({ required_error: 'username and password are required' })
      .min(3, 'Username must be 3-30 characters')
      .max(30, 'Username must be 3-30 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
    password: z
      .string({ required_error: 'username and password are required' })
      .min(8, 'Password must be 8-128 characters')
      .max(128, 'Password must be 8-128 characters')
      .refine((val) => passwordStrengthScore(val) >= 3, {
        message: 'Password must include a mix of uppercase, lowercase, numbers, and special characters',
      }),
    inviteCode: z.string().optional().default(''),
  })
  .strict();

function passwordStrengthScore(password: string): number {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;
  return score;
}

function validateCredentials(
  body: unknown,
  res: import('express').Response
): { username: string; password: string; inviteCode: string } | null {
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    // The `error` field carries the human-readable summary; the existing
    // auth-extended.test.ts assertions match the Zod messages directly
    // (e.g. /letters.*numbers.*underscores/i, /3.*30 characters/i,
    // /8.*128 characters/i). We surface those messages in `error` so the
    // client + tests can read the precise reason. `details` is the joined
    // issues list, kept for callers that want a structured form.
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    res.status(400).json({
      success: false as const,
      error: detail || 'Invalid credentials',
      details: detail,
    });
    return null;
  }
  return parsed.data;
}

// ---------- POST /api/auth/register ----------
authRouter.post('/register', asyncHandler(async (req, res) => {
  const creds = validateCredentials(req.body, res);
  if (!creds) return;
  const { username, password, inviteCode } = creds;

  // SINGLE_USER_MODE: if registration is disabled, only allow registration
  // with a valid invite code. This prevents random internet visitors from
  // creating accounts on a personal/production instance.
  if (isRegistrationDisabled()) {
    const expected = getInviteCode();
    // L6: timing-safe invite-code comparison (digests, mirrors admin.ts).
    const providedDigest = crypto.createHmac('sha256', 'invite').update(inviteCode ?? '').digest();
    const expectedDigest = crypto.createHmac('sha256', 'invite').update(expected ?? '').digest();
    if (!expected || providedDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(providedDigest, expectedDigest)) {
      logger.warn({ username, hasInvite: inviteCode !== '' }, 'Registration blocked in single-user mode');
      res.status(403).json({ success: false, error: 'Registration is disabled' });
      return;
    }
  }

  const passwordHash = await bcrypt.hash(password, getBcryptRounds());

  // First registered user becomes admin (bootstrap), all others are regular users.
  // We use a PostgreSQL advisory transaction lock to prevent a TOCTOU race where
  // two simultaneous registrations on an empty DB both create admin users. The
  // lock is released automatically when the transaction commits or rolls back.
  //
  // HIGH-6: The "first user becomes admin" behavior is gated by
  // `shouldBootstrapFirstUserAsAdmin()`. In invite-only mode
  // (DISABLE_REGISTRATION=true), the first registration is implicitly
  // operator-trusted and remains admin. In open registration mode, the
  // first user is a regular user unless BOOTSTRAP_FIRST_USER_ADMIN=true is
  // set explicitly — eliminating the "whoever registers first owns the
  // deployment" footgun for fresh public instances.
  const FIRST_USER_ADVISORY_LOCK_KEY = 123456789;

  try {
    const user = await prisma().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${FIRST_USER_ADVISORY_LOCK_KEY})::text`;
      const existing = await tx.user.findFirst({ select: { id: true } });
      const isFirstUser = !existing;
      const role: 'admin' | 'user' = isFirstUser && shouldBootstrapFirstUserAsAdmin() ? 'admin' : 'user';
      return tx.user.create({
        data: { username, passwordHash, role },
      });
    });
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };
    const token = signToken(payload);
    res.cookie(JWT_COOKIE, token, JWT_COOKIE_OPTIONS);
    // Issue a fresh CSRF token so the client can mutate immediately.
    setCsrfCookie(res, generateCsrfToken());
    logger.info({ username }, 'User registered');
    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, username: user.username, role: user.role },
        token,
      },
    });
  } catch (err) {
    const prismaErr = err as { code?: string } | null;
    if (prismaErr?.code === 'P2002') {
      res.status(409).json({ success: false as const, error: 'Username already taken' });
      return;
    }
    logger.error({ err }, 'Registration failed');
    res.status(500).json({ success: false as const, error: 'Registration failed' });
  }
}));

// ---------- POST /api/auth/login ----------
authRouter.post('/login', asyncHandler(async (req, res) => {
  const creds = validateCredentials(req.body, res);
  if (!creds) return;
  const { username, password } = creds;

  // Fix LOW-2: Always run bcrypt.compare regardless of whether user exists,
  // preventing timing-based username enumeration. The DUMMY_HASH ensures both
  // paths (user-found + wrong-password vs user-not-found) take ~237ms.
  const user = await prisma().user.findUnique({ where: { username } });
  // L16: synthetic service accounts ('system', 'global') must never be
  // usable for interactive login, even if their password hash were somehow
  // valid. Treat them as non-existent for the comparison so timing is still
  // protected by the dummy hash.
  const isSynthetic = user && (user.id === 'system' || user.id === 'global');
  const hashForCompare = user && !isSynthetic ? user.passwordHash : await getDummyHash();

  let passwordOk = false;
  try {
    passwordOk = await bcrypt.compare(password, hashForCompare);
  } catch (err) {
    // A malformed/stored hash must not become a 500; treat it as a failed
    // credential check and log server-side for investigation.
    logger.warn({ err, username }, 'Login bcrypt comparison failed (malformed hash?)');
    passwordOk = false;
  }

  if (!user || isSynthetic || !passwordOk) {
    logger.warn({ username }, 'Failed login — invalid credentials');
    res.status(401).json({ success: false as const, error: 'Invalid credentials' });
    return;
  }

  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };
  const token = signToken(payload);
  res.cookie(JWT_COOKIE, token, JWT_COOKIE_OPTIONS);
  // Issue a fresh CSRF token so the client can mutate immediately.
  setCsrfCookie(res, generateCsrfToken());
  logger.info({ username }, 'Login successful');
  res.json({
    success: true,
    data: {
      user: { id: user.id, username: user.username, role: user.role },
      token,
    },
  });
}));

// ---------- DELETE /api/auth/logout ----------
// Accept token from cookie or Authorization: Bearer header. Cookie takes
// precedence when both are present (same logic as jwtMiddleware).
// Fix: Clients authenticating via Bearer header should also be able to logout.
// Only the cookie version clears the cookie; for header-auth clients, logout
// is a no-op (they just discard their token).
//
// SEC-003: On logout, the token's unique jti is added to a Redis blacklist
// so it cannot be reused. This invalidates the token server-side even though
// JWT is stateless. The blacklist entry has a TTL matching the token's remaining
// validity window, so expired blacklist entries are automatically cleaned.
authRouter.post('/logout', asyncHandler(async (req, res) => {
  // POST alias for logout — delegates to the DELETE handler via shared logic.
  // Some API conventions prefer POST for session termination; supporting both
  // avoids client breakage.
  await handleLogout(req, res);
}));

authRouter.delete('/logout', asyncHandler(async (req, res) => {
  await handleLogout(req, res);
}));

async function handleLogout(req: import('express').Request, res: import('express').Response): Promise<void> {
  const cookieToken = req.cookies[JWT_COOKIE];
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const token = cookieToken || headerToken;

  if (!token) {
    res.status(401).json({ success: false as const, error: 'Not authenticated' });
    return;
  }

  // Verify the token is valid before clearing
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ success: false as const, error: 'Token expired or invalid' });
    return;
  }

  // SEC-003: Blacklist the token server-side so it cannot be reused.
  // This runs BEFORE clearing cookies so the blacklist is written even
  // if the subsequent cookie clear fails.
  await blacklistToken(payload);

  // Clear the cookie if it was used for auth
  if (cookieToken) {
    res.clearCookie(JWT_COOKIE, JWT_COOKIE_OPTIONS);
  }
  // Also clear the CSRF token — after logout, the next request is
  // unauthenticated and any in-flight CSRF token from the prior session
  // should not be reusable.
  res.clearCookie('XSRF-TOKEN', { path: '/' });
  res.json({ success: true });
}

// ---------- POST /api/auth/refresh ----------
// Accept token from cookie or Authorization: Bearer header. Cookie takes
// precedence when both are present (same logic as jwtMiddleware).
// Fix: The previous version only read from the cookie, which meant clients
// authenticating via Bearer header could not refresh their token.
//
// SEC-003: On refresh, the old token is blacklisted so it cannot be reused.
// The new token gets a fresh jti. This means a logged-out user who captured
// a previous refresh token cannot use it after the refresh cycle completes.
authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const cookieToken = req.cookies[JWT_COOKIE];
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const token = cookieToken || headerToken;
  if (!token) {
    res.status(401).json({ success: false as const, error: 'No token to refresh' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ success: false as const, error: 'Token expired or invalid' });
    return;
  }

  // SEC-003: Check if this token has already been blacklisted (replay attack).
  // Without this check, a captured refresh token can be reused multiple times
  // until its original expiry, minting multiple valid sessions.
  const alreadyBlacklisted = await isTokenBlacklisted(payload);
  if (alreadyBlacklisted) {
    res.status(401).json({ success: false as const, error: 'Token has already been refreshed or revoked' });
    return;
  }

  // H8: Revalidate against the database before minting a new token. The old
  // code copied claims verbatim from the previous token, so a demoted admin
  // kept role:'admin' forever via 15-minute refreshes, and a deleted user
  // retained full API access indefinitely through the refresh chain.
  const dbUser = await prisma().user.findUnique({ where: { id: payload.sub } });
  if (!dbUser) {
    res.status(401).json({ success: false as const, error: 'Account no longer exists' });
    return;
  }

  // SEC-003: Blacklist the old token so it cannot be reused.
  // The new token gets a fresh jti, so the old one is immediately invalid.
  await blacklistToken(payload);

  const newToken = signToken({ sub: dbUser.id, username: dbUser.username, role: dbUser.role });
  res.cookie(JWT_COOKIE, newToken, JWT_COOKIE_OPTIONS);
  // Rotate the CSRF token on every refresh — the previous token is now
  // invalid even if a copy was leaked.
  setCsrfCookie(res, generateCsrfToken());
  res.json({ success: true });
}));

// ---------- GET /api/auth/me ----------
// Auth routes mount BEFORE jwtMiddleware, so req.user is NOT set by jwtMiddleware.
// We read and verify the JWT token directly here (cookie or Bearer header).
// Cookie takes precedence when both are present (same logic as jwtMiddleware).
// Fix: The previous version only read from the cookie, which meant clients
// authenticating via Bearer header could not query their own user info.
//
// SEC-003: Check the token blacklist here (same as jwtMiddleware does for other
// routes). The auth router is mounted before jwtMiddleware, so /me would
// otherwise accept blacklisted tokens. This ensures a logged-out user's token
// is rejected even for /me.
authRouter.get('/me', asyncHandler(async (req, res) => {
  const cookieToken = req.cookies[JWT_COOKIE];
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const token = cookieToken || headerToken;
  if (!token) {
    res.status(401).json({ success: false as const, error: 'Unauthorized' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ success: false as const, error: 'Unauthorized' });
    return;
  }

  // SEC-003: Reject blacklisted tokens even at /me
  const blacklisted = await isTokenBlacklisted(payload);
  if (blacklisted) {
    res.status(401).json({ success: false as const, error: 'Unauthorized' });
    return;
  }

  res.json({
    success: true,
    data: { user: { id: payload.sub, username: payload.username, role: payload.role } },
  });
}));