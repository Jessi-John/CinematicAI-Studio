import rateLimit, { MemoryStore, type RateLimitRequestHandler, type Store } from 'express-rate-limit';
import type express from 'express';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getSharedRedis } from '../lib/shared-redis.js';
import { logger } from '../services/logger.js';
import { e2eTestBypassEnabled } from '../config/env.js';

// MEDIUM #65: Lazy-load the shared Redis client so importing this module does
// not trigger an immediate connection attempt. This removes Redis ECONNREFUSED
// noise from test output and avoids side effects at import time.
let rateLimitRedis: ReturnType<typeof getSharedRedis> | undefined;
function getRateLimitRedis(): ReturnType<typeof getSharedRedis> {
  if (!rateLimitRedis) {
    rateLimitRedis = getSharedRedis();
    rateLimitRedis.on('error', (err: Error) => {
      logger.error({ err }, 'Rate-limit Redis error');
    });
  }
  return rateLimitRedis;
}

type StoreBackedLimiter = RateLimitRequestHandler & { store: Store };

interface LimiterOpts {
  windowMs: number;
  max: number;
  message: string;
  prefix: string;
  /**
   * Optional key generator. Defaults to the request IP. Pass
   * `userKeyOrIp` to key on the authenticated user id (with IP fallback).
   */
  keyGenerator?: (req: express.Request) => string;
}

/**
 * Fix #32: key generator that prefers the authenticated user id, falling
 * back to the request IP for unauthenticated requests. The user id comes
 * from `req.user.sub` (set by `jwtMiddleware`).
 */
function userKeyOrIp(req: express.Request): string {
  const user = (req as express.Request & { user?: { sub?: string } }).user;
  if (user?.sub) return `user:${user.sub}`;
  // `req.ip` respects `app.set('trust proxy', N)`. We set trust proxy to 1
  // in server.ts so the X-Forwarded-For from a single reverse proxy is
  // honoured. We do NOT trust arbitrary client-set headers.
  return `ip:${req.ip ?? 'unknown'}`;
}

function makeLimiter({ windowMs, max, message, prefix, keyGenerator }: LimiterOpts) {
  // Eagerly initialize the Redis store synchronously so every request uses
  // the Redis-backed store from the very first request. Previously the store
  // was initialized lazily on the first request, which meant the first request
  // used the default in-memory store (express-rate-limit's built-in), and the
  // Redis store was only swapped in after the async init completed. This caused
  // rate limit keys to live only in process memory (not Redis), making them
  // invisible to redis-cli KEYS/SCAN and lost on process restart.
  //
  // Initialization runs eagerly at module load time but is async (requires
  // Redis PING + Lua script loading). We start the init immediately and use
  // a promise that the request handler can await if init hasn't settled yet.
  let store: Store | undefined;
  let storeCreationFailed = false;

  const initStore = async (): Promise<void> => {
    const redis = getRateLimitRedis();
    const redisStore = new RedisStore({
      sendCommand: async (command: string, ...args: string[]): Promise<RedisReply> => {
        // @ts-expect-error - ioredis call returns RedisReply which is compatible
        return await redis.call(command, ...args);
      },
      prefix,
    });

    // The RedisStore constructor starts eager SCRIPT LOAD promises. If Redis
    // is down, those promises reject before our initStore() awaits them, which
    // the Node runtime reports as unhandled rejections (and crashes the process
    // in production). Attach a no-op handler so they are considered handled; the
    // original rejection is still re-thrown when initStore awaits them below.
    (redisStore as { incrementScriptSha?: Promise<unknown> }).incrementScriptSha?.catch(() => {});
    (redisStore as { getScriptSha?: Promise<unknown> }).getScriptSha?.catch(() => {});

    if (typeof redisStore.init === 'function') {
      const initOptions = { windowMs, max } as Parameters<NonNullable<Store['init']>>[0];
      redisStore.init(initOptions);
    }

    // Verify Redis connectivity — fail fast if Redis is down
    // (redis is a mocked ioredis instance in tests; .ping() is not
    // available on the generic `call` mock so we use redis.call('PING'))
    try {
      if (typeof redis.ping === 'function') {
        await redis.ping();
      } else {
        // Fallback for mocks that don't implement .ping()
        await redis.call('PING');
      }
    } catch (pingErr) {
      storeCreationFailed = true;
      logger.error({ err: pingErr, prefix }, 'Redis ping failed — rate limiter cannot operate');
      throw pingErr;
    }

    try {
      await Promise.all([
        redisStore.incrementScriptSha,
        redisStore.getScriptSha,
      ]);
    } catch (err) {
      storeCreationFailed = true;
      logger.error({ err, prefix }, 'Failed to load Redis rate-limit scripts');
      throw err;
    }

    store = redisStore;
  };

  // Start initialization eagerly. If it fails, storeCreationFailed is set
  // and the request handler will return 503 (prod) or fall back to memory
  // (dev/test). We do NOT reassign storeInitPromise to undefined in the
  // catch handler because the request handler may still reference it.
  const storeInitPromise = initStore()
    .catch((err) => {
      storeCreationFailed = true;
      if (process.env.NODE_ENV === 'production') {
        logger.error({ err, prefix }, 'Failed to build Redis rate-limit store in production');
      } else {
        logger.warn({ err, prefix }, 'Failed to build Redis rate-limit store, falling back to memory');
      }
    });

  const isProd = process.env.NODE_ENV === 'production';

  // Lazily-delegating store wired into rateLimit() AT CREATION. express-rate-
  // limit v7 resolves `config.store` once at creation (dist/index.cjs:678:
  // `store: promisifyStore(options.store ?? new MemoryStore())`), so the
  // previous `limiter.store = store` post-assignment never took effect —
  // every limiter silently used a per-process MemoryStore, making rate
  // limits per-replica (not shared/persistent as designed) and the Redis
  // store dead code at runtime. This delegating store awaits the eager init,
  // then delegates to the Redis store when available, falling back to a
  // per-limiter MemoryStore when Redis init failed (dev) — preserving all
  // existing init-failure semantics while making runtime increments actually
  // Redis-backed and shared across replicas.
  const memoryFallback = new MemoryStore();
  const delegatingStore = {
    increment: async (key: string) => {
      await storeInitPromise;
      const target = store ?? memoryFallback;
      return target.increment(key);
    },
    decrement: async (key: string) => {
      await storeInitPromise;
      const target = store ?? memoryFallback;
      return target.decrement(key);
    },
    resetKey: async (key: string) => {
      await storeInitPromise;
      const target = store ?? memoryFallback;
      return target.resetKey(key);
    },
    resetAll: async () => {
      await storeInitPromise;
      const target = store ?? memoryFallback;
      if (typeof target.resetAll === 'function') await target.resetAll();
    },
  } as unknown as Store;

  const limiter = rateLimit({
    windowMs,
    max,
    message: { success: false, error: message },
    standardHeaders: true,
    legacyHeaders: false,
    // In express-rate-limit v7, passOnStoreError semantics are: true = log the
    // store error and ALLOW the request (fail open); false = throw (fail
    // closed via the global errorHandler). `!isProd` therefore makes
    // production fail CLOSED and dev/test fail OPEN — matching the JWT
    // blacklist's fail-closed behavior in the same outage. (H15 note: an
    // earlier audit misread these semantics and inverted them; verified
    // against node_modules/express-rate-limit/dist/index.cjs:716-724.)
    passOnStoreError: !isProd,
    keyGenerator: keyGenerator ?? userKeyOrIp,
    store: delegatingStore,
  }) as StoreBackedLimiter;

  // (The Redis store is wired at creation via delegatingStore above — no
  // post-hoc `limiter.store` assignment is needed, and per express-rate-limit
  // v7 internals it would not take effect anyway.)

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Always wait for store init to settle before deciding the path.
    // The init runs eagerly at module load time but is async (requires
    // Redis PING + Lua script loading). We must await here because the
    // async init may not have settled by the time the first request arrives.
    await storeInitPromise;

    if (storeCreationFailed) {
      if (isProd) {
        res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
        return;
      }
      // Dev/test: use the in-memory store (no Redis required)
      limiter(req, res, next);
      return;
    }
    // H15 FIX: express-rate-limit v7 with passOnStoreError:false throws on
    // store errors, but Express 4 does not catch rejected promises from
    // non-error-handler middleware — the throw becomes an unhandled rejection
    // and the request silently continues to the route handler, bypassing the
    // rate limiter entirely (fail-open despite passOnStoreError:false). Wrap
    // in try/catch to fail-closed in production (503) on any store error.
    try {
      limiter(req, res, next);
    } catch (err) {
      if (isProd) {
        logger.error({ err, prefix }, 'Rate limiter store error in production — failing closed');
        res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
        return;
      }
      // Dev/test: allow through on store error
      next();
    }
  };
}

// General API: 100 requests per minute
export const generalLimiter = makeLimiter({
    windowMs: 60_000,
    max: 100,
    message: 'Too many requests, please try again later.',
    prefix: 'rl:general:',
  });

/**
 * Fix #32: Per-user limiter that runs ALONGSIDE the IP-keyed limiters.
 *
 * The previous design keyed every limiter on the request IP. A user
 * behind a NAT (corporate office, school, public WiFi) shared their
 * budget with everyone else on that NAT — one noisy neighbour would
 * burn through the budget for the whole subnet.
 *
 * This limiter keys on the authenticated user id (set by `jwtMiddleware`).
 * For unauthenticated requests it falls back to the IP, so the
 * protections still apply to the auth routes themselves.
 *
 * It is NOT a standalone limiter — wrap it in front of an existing
 * limiter so you get both keys. Mounting it standalone would only
 * limit per-user, not per-IP, which would still allow a single user
 * to saturate a server with thousands of requests in parallel.
 */
export const perUserLimiter = makeLimiter({
  windowMs: 60_000,
  // Generous default — intended to catch abuse, not normal use.
  max: 200,
  message: 'Too many requests for this user, please try again later.',
  prefix: 'rl:user:',
  // Use the user-keyed generator; the makeLimiter default is the same
  // function, but spelling it out here documents intent and lets a
  // future IP-only override be opt-in via a different limiter.
  keyGenerator: userKeyOrIp,
});

// Lazy getters for AI rate-limit config — evaluated after validateAndLoadEnv() completes.
// These functions log a warning and fall back to safe defaults instead of throwing
// synchronously at module load, which would prevent the server from starting when
// an env var is malformed. Hard failures are reserved for validateAndLoadEnv().
function getAiRateLimitMax(): number {
  const raw = parseInt(process.env.AI_RATE_LIMIT_MAX || '10', 10);
  if (!Number.isSafeInteger(raw) || raw < 1) {
    logger.warn({ raw: process.env.AI_RATE_LIMIT_MAX }, 'AI_RATE_LIMIT_MAX invalid; using default 10');
    return 10;
  }
  if (process.env.NODE_ENV === 'production' && raw > 10) {
    logger.warn({ max: raw }, 'AI_RATE_LIMIT_MAX exceeds production maximum; clamping to 10');
    return 10;
  }
  return raw;
}
function isAiBypassEnabled(): boolean {
  // E2E_TEST bypass: parallel E2E workers exhaust the 10 req/min limit
  // on POST /api/stories/generate within seconds. Gated on non-production via
  // e2eTestBypassEnabled() so a leaked E2E_TEST=true cannot disable the limit.
  return process.env.NODE_ENV === 'test' || e2eTestBypassEnabled();
}
const aiNoop = ((_req: express.Request, _res: express.Response, next: express.NextFunction): void => { next(); }) as unknown as RateLimitRequestHandler;
export const aiLimiter: RateLimitRequestHandler = isAiBypassEnabled()
  ? aiNoop
  : makeLimiter({
      windowMs: 60_000,
      max: getAiRateLimitMax(),
      message: 'AI endpoint rate limit exceeded, please try again later.',
      prefix: 'rl:ai:',
    }) as unknown as RateLimitRequestHandler;

// Auth endpoint rate limiters — split by function so a burst on one
// endpoint doesn't exhaust the budget for another:
//
//   register: 3 req/15min — account creation is rare; no legitimate user
//             needs more than 3 attempts in 15 minutes.
//   login:    10 req/15min — brute-force protection (original single-bucket
//             limit that covered all auth routes).
//   session:  30 req/15min — GET /me, POST /refresh, POST /logout. These
//             are session management calls that shouldn't be constrained by
//             the same tight budget as login/register.
//
// register and login also pass through sessionLimiter (because they're
// on the same /api/auth prefix), but their own tighter limit is always
// the effective bottleneck.
//
// In NODE_ENV=test all limiters are no-ops — the test suite makes ~10 auth
// requests across multiple test files in under 30 seconds.
// When E2E_TEST=true (Playwright E2E against Docker stack), bypass is also
// enabled.
const authNoop = ((_req: express.Request, _res: express.Response, next: express.NextFunction): void => { next(); }) as unknown as RateLimitRequestHandler;
function isAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || e2eTestBypassEnabled();
}
// Lazy getters for auth rate-limit config — evaluated after validateAndLoadEnv() completes.
// These functions log a warning and fall back to safe defaults instead of throwing
// synchronously at module load, which would prevent the server from starting when
// an env var is malformed.
function getRegisterRateLimitMax(): number {
  const raw = parseInt(process.env.AUTH_REGISTER_RATE_LIMIT_MAX || '10', 10);
  if (!Number.isSafeInteger(raw) || raw < 1) {
    logger.warn({ raw: process.env.AUTH_REGISTER_RATE_LIMIT_MAX }, 'AUTH_REGISTER_RATE_LIMIT_MAX invalid; using default 10');
    return 10;
  }
  return raw;
}
function getLoginRateLimitMax(): number {
  const raw = parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX || '10', 10);
  if (!Number.isSafeInteger(raw) || raw < 1) {
    logger.warn({ raw: process.env.AUTH_LOGIN_RATE_LIMIT_MAX }, 'AUTH_LOGIN_RATE_LIMIT_MAX invalid; using default 10');
    return 10;
  }
  return raw;
}
function getSessionRateLimitMax(): number {
  const raw = parseInt(process.env.AUTH_SESSION_RATE_LIMIT_MAX || '30', 10);
  if (!Number.isSafeInteger(raw) || raw < 1) {
    logger.warn({ raw: process.env.AUTH_SESSION_RATE_LIMIT_MAX }, 'AUTH_SESSION_RATE_LIMIT_MAX invalid; using default 30');
    return 30;
  }
  return raw;
}

// Auth registers are throttled aggressively (10/15min by default) because the
// account-creation surface is the most common spam vector. Admins can adjust
// via AUTH_REGISTER_RATE_LIMIT_MAX env var, or disable entirely in CI/E2E
// contexts by setting E2E_TEST=true (see isAuthBypassEnabled above).
export const registerLimiter: RateLimitRequestHandler = isAuthBypassEnabled()
  ? authNoop
  : makeLimiter({
      windowMs: 15 * 60_000,
      max: getRegisterRateLimitMax(),
      message: 'Too many registration attempts. Please try again later.',
      prefix: 'rl:register:',
    }) as unknown as RateLimitRequestHandler;
// Login throttled at 10/15min by default to prevent brute-force attacks.
// Adjust via AUTH_LOGIN_RATE_LIMIT_MAX env var. Set E2E_TEST=true to disable.
export const loginLimiter: RateLimitRequestHandler = isAuthBypassEnabled()
  ? authNoop
  : makeLimiter({
      windowMs: 15 * 60_000,
      max: getLoginRateLimitMax(),
      message: 'Too many login attempts. Please try again later.',
      prefix: 'rl:login:',
    }) as unknown as RateLimitRequestHandler;
// Session operations (GET /me, POST /refresh, POST /logout) have a wider
// budget since they are driven by legitimate client-side polling.
// Adjust via AUTH_SESSION_RATE_LIMIT_MAX env var.
export const sessionLimiter: RateLimitRequestHandler = isAuthBypassEnabled()
  ? authNoop
  : makeLimiter({
      windowMs: 15 * 60_000,
      max: getSessionRateLimitMax(),
      message: 'Too many session requests. Please try again later.',
      prefix: 'rl:session:',
    }) as unknown as RateLimitRequestHandler;

// Backward-compatible alias — test files mock `authLimiter` across 12 files.
// Points to loginLimiter as the most representative (original combined limit).
export const authLimiter = loginLimiter;

// Export endpoint: 30 requests per minute
export const exportLimiter = makeLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Export rate limit exceeded, please try again later.',
  prefix: 'rl:export:',
});

// Stories CRUD endpoint: 60 requests per minute
export const storiesLimiter = makeLimiter({
  windowMs: 60_000,
  max: 60,
  message: 'Story operations rate limit exceeded, please try again later.',
  prefix: 'rl:stories:',
});

// Health check endpoint: generous limits to allow load balancer probes
// while still preventing abuse (1000/min ≈ 16/second).
export const healthLimiter = makeLimiter({
  windowMs: 60_000,
  max: 1000,
  message: 'Health check rate limit exceeded.',
  prefix: 'rl:health:',
});

// Job/SSE endpoint: 60 requests per minute
export const jobsLimiter = makeLimiter({
  windowMs: 60_000,
  max: 60,
  message: 'Job status rate limit exceeded, please try again later.',
  prefix: 'rl:jobs:',
});
