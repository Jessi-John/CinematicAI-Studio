import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { prisma } from '../database/prisma.js';
import { getSharedRedis } from '../lib/shared-redis.js';
import { verifyToken, JWT_COOKIE } from '../middleware/jwt.js';

// LIVE-6: Use a short timeout (2s) so the health endpoint returns quickly
// during a Redis outage instead of hanging for the full guard timeout.
const HEALTH_REDIS_PING_TIMEOUT_MS = 2_000;

const router = Router();

async function pingRedis(): Promise<'connected' | 'disconnected'> {
  const redis = getSharedRedis();
  // REL-030: Timeout guard using callback setTimeout + clearTimeout.
  // Must NOT use Promise.race with sleep().then(disconnect) — Promise.race
  // does NOT cancel loser promises, so the .then(disconnect) always runs
  // HEALTH_REDIS_PING_TIMEOUT_MS after EVERY health check, even when ping
  // succeeded in 1ms. This silently disconnects the shared client, causing
  // all subsequent health checks to report "disconnected".
  // unref so the timer doesn't block Node.js process shutdown while
  // redis.ping() is in-flight (e.g. SIGTERM during a slow connect).
  // CRITICAL: Do NOT call redis.disconnect() here. This is the shared Redis
  // client used by rate limiting, idempotency keys, SSE buffering, and token
  // blacklisting. Disconnecting it breaks all Redis-dependent features for
  // the lifetime of the process. On timeout, just report 'disconnected' —
  // the caller will retry on the next health check.
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
  }, HEALTH_REDIS_PING_TIMEOUT_MS).unref();

  try {
    const result = await redis.ping();
    clearTimeout(timeoutTimer);
    if (timedOut) return 'disconnected';
    if (result?.toString().toUpperCase() !== 'PONG') {
      return 'disconnected';
    }
    return 'connected';
  } catch {
    clearTimeout(timeoutTimer);
    return 'disconnected';
  }
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    let dbStatus: 'connected' | 'disconnected' = 'connected';
    let redisStatus: 'connected' | 'disconnected' = 'connected';

    try {
      await prisma().$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'disconnected';
    }

    redisStatus = await pingRedis();

    const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';

    // L14: version and uptime are fingerprinting aids — only expose them to
    // authenticated callers (the admin/settings dashboards use them).
    const token = (_req.cookies as Record<string, string | undefined> | undefined)?.[JWT_COOKIE];
    const authed = token ? verifyToken(token) !== null : false;

    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      data: {
        status: isHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        services: { database: dbStatus, redis: redisStatus },
        ...(authed ? { uptime: process.uptime(), version: '1.0.0' } : {}),
      },
    });
  })
);

export const healthRouter = router;
