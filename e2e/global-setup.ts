/**
 * Playwright Global Setup
 *
 * Clears Redis rate-limit keys before E2E tests run.
 * The auth rate limiter (10 req/15min per IP) blocks consecutive test runs
 * because the Docker backend runs with NODE_ENV=production (not 'test'),
 * so the test-mode bypass in rate-limit.ts is inactive.
 *
 * This setup connects to Redis, deletes all rl:* keys, and disconnects.
 * It runs once at the start of the Playwright test session.
 *
 * Network fix: The REDIS_URL from .env uses Docker's internal hostname
 * ("redis") which is unresolvable from the host machine where Playwright
 * runs. We detect this and fall back to localhost with the same auth,
 * since docker-compose maps port 6379 from the container to the host.
 */

import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load .env so REDIS_URL is available when running Playwright from host
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', 'backend', '.env') });

/**
 * Resolve a Redis URL that may contain a Docker-internal hostname ("redis")
 * to a host-accessible URL (localhost). Preserves auth credentials and port.
 */
function resolveRedisUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // If the hostname is "redis" (Docker internal), replace with localhost
    // since docker-compose maps the Redis port to the host.
    if (url.hostname === 'redis') {
      url.hostname = 'localhost';
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function getResolvedRedisUrl(): string {
  // H21/LIVE-2: prefer the SAME secret file the containers use so the test
  // harness can never drift out of sync with the deployment (the .env
  // local_dev password and secrets/ were out of sync on real dev machines,
  // causing every Redis-dependent test to silently skip).
  try {
    const secretPath = path.resolve(__dirname, '..', 'secrets', 'redis_url');
    if (fs.existsSync(secretPath)) {
      const fromSecret = fs.readFileSync(secretPath, 'utf8').trim();
      if (fromSecret) return resolveRedisUrl(fromSecret);
    }
  } catch {
    // fall through to env-based resolution
  }
  const raw = process.env.REDIS_URL;
  const resolved = raw || 'redis://localhost:6379';
  if (resolved.includes('__SET_ME_TO_') || resolved.includes('placeholder')) {
    // If REDIS_URL contains placeholders, read REDIS_PASSWORD from env and
    // construct a URL targeting the Docker service hostname. This avoids
    // hardcoded dev passwords that silently drift from the real .env value.
    // H21: no hardcoded fallback password — fail fast with a clear error.
    const pw = process.env.REDIS_PASSWORD;
    if (!pw) {
      throw new Error(
        'REDIS_URL contains placeholders and REDIS_PASSWORD is not set. ' +
        'Set REDIS_PASSWORD or create secrets/redis_url (see scripts/generate-secrets.sh).'
      );
    }
    return `redis://:${pw}@redis:6379`;
  }
  return resolveRedisUrl(resolved);
}

async function globalSetup(): Promise<void> {
  const redisUrl = getResolvedRedisUrl();
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true,
  });
  // Handle ioredis error events that fire during lazyConnect hostname
  // resolution (expected when Docker hostname "redis" is not resolvable).
  // Log non-ECONNREFUSED errors to stderr so they're visible in CI logs.
  redis.on('error', (err: Error) => {
    // H21: `!(err as any).code === 'ECONNREFUSED'` was an operator-precedence
    // bug — `!x === y` parses as `(!x) === y`, which is always false, so the
    // suppression never fired and EVERY Redis error hit stderr.
    if (err && (err as { code?: string }).code !== 'ECONNREFUSED') {
      process.stderr.write(`[global-setup] Redis error: ${err.message}\n`);
    }
  });

  // H21: The rl:*/bull:* flush below DELETES every rate-limit and BullMQ key
  // on whatever Redis REDIS_URL resolves to — including a shared dev Redis
  // with live queued jobs. Require an explicit opt-in so an accidental
  // `npx playwright test` against a non-test Redis cannot cause data loss.
  if (process.env.E2E_REDIS_FLUSH !== '1') {
    console.log(
      '[global-setup] E2E_REDIS_FLUSH is not set to 1 — skipping rl:*/bull:* flush. ' +
      'Set E2E_REDIS_FLUSH=1 when running against the disposable e2e stack (docker-compose.e2e.yml).'
    );
    await redis.quit().catch(() => undefined);
    return;
  }

  try {
    await redis.connect();
    // Step 1: Scan and delete all rate-limit keys
    let cursor = '0';
    let deletedCount = 0;
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        'rl:*',
        'COUNT',
        500
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    if (deletedCount > 0) {
      console.log(
        `[global-setup] Cleared ${deletedCount} Redis rate-limit keys`
      );
    } else {
      console.log('[global-setup] No Redis rate-limit keys to clear');
    }

    // Step 2: Flush stale BullMQ job queues (keys matching bull:*).
    // Previous test runs leave queued jobs that block new jobs behind
    // worker concurrency=2 and rate limit 10 jobs/min. Draining the
    // queues ensures every test run starts with a clean slate.
    let bullCursor = '0';
    let bullDeleted = 0;
    do {
      const [nextCursor, keys] = await redis.scan(
        bullCursor,
        'MATCH',
        'bull:*',
        'COUNT',
        500
      );
      bullCursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        bullDeleted += keys.length;
      }
    } while (bullCursor !== '0');

    if (bullDeleted > 0) {
      console.log(`[global-setup] Flushed ${bullDeleted} BullMQ queue keys`);
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOTFOUND') {
      // DNS resolution failure — try connecting via localhost directly.
      // This handles the case where the Docker container hostname is
      // not resolvable from the CI/host runner.
      // The Docker Redis requires password auth, which we extract from
      // the original REDIS_URL to build the localhost connection string.
      console.warn(
        '[global-setup] DNS resolution failed for Redis URL, trying localhost...'
      );
      try {
        // Extract password from the original REDIS_URL
        let fallbackUrl = 'redis://localhost:6379';
        try {
          const parsed = new URL(process.env.REDIS_URL!);
          if (parsed.password) {
            fallbackUrl = `redis://:${parsed.password}@localhost:6379`;
          }
        } catch {
          // use default without auth
        }
        const fallbackRedis = new Redis(fallbackUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
          lazyConnect: true,
        });
        fallbackRedis.on('error', () => {});
        await fallbackRedis.connect();
        // Scan and delete all rate-limit keys (same as primary path)
        let cursor = '0';
        let deletedCount = 0;
        do {
          const [nextCursor, keys] = await fallbackRedis.scan(
            cursor,
            'MATCH',
            'rl:*',
            'COUNT',
            500
          );
          cursor = nextCursor;
          if (keys.length > 0) {
            await fallbackRedis.del(...keys);
            deletedCount += keys.length;
          }
        } while (cursor !== '0');
        console.log(
          `[global-setup] Cleared ${deletedCount} Redis rate-limit keys via localhost fallback`
        );

        // Flush BullMQ queues via fallback connection too
        let bullCursor = '0';
        let bullDeleted = 0;
        do {
          const [nextCursor, keys] = await fallbackRedis.scan(
            bullCursor,
            'MATCH',
            'bull:*',
            'COUNT',
            500
          );
          bullCursor = nextCursor;
          if (keys.length > 0) {
            await fallbackRedis.del(...keys);
            bullDeleted += keys.length;
          }
        } while (bullCursor !== '0');
        if (bullDeleted > 0) {
          console.log(`[global-setup] Flushed ${bullDeleted} BullMQ queue keys via localhost fallback`);
        }

        await fallbackRedis.quit().catch(() => {});
        return;
      } catch (fallbackErr) {
        console.warn(
          '[global-setup] Fallback to localhost also failed:',
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        );
      }
    }
    console.warn(
      '[global-setup] Could not connect to Redis to clear rate limits:',
      err instanceof Error ? err.message : String(err)
    );
    console.warn(
      '[global-setup] Tests may fail with 429 rate-limiting errors.'
    );
    // Fix HIGH-7: Redact password from Redis URL before logging
    const redactedUrl = getResolvedRedisUrl().replace(/redis:\/\/:([^@]+)@/, 'redis://:***@');
    console.warn(
      `[global-setup] Ensure Redis is running at ${redactedUrl}`
    );
  } finally {
    await redis.quit().catch(() => {});
  }
}

export default globalSetup;
