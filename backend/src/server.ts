// CinematicAI Backend — Express server entry point.
// Single-user app; API authentication via bearer token.

// Tracing MUST be first import to ensure all modules are instrumented
import './lib/tracing.js';

// HTTP transport: install the undici Agent with socket-level timeouts
// BEFORE any module that may issue a fetch. This guarantees every
// outbound call is bound by connect/headers/body timeouts, even if
// the JS-level AbortController watchdog is starved by main-thread
// pressure.
import { installHttpTransport } from './lib/http-transport.js';
installHttpTransport();

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { loadEnvFiles } from './config/load-env.js';
loadEnvFiles();

// Env validation MUST run first before any module with side effects (e.g. rate-limit
// which connects to Redis via getSharedRedis). validateAndLoadEnv() is cached so
// all subsequent calls to get*() functions return immediately without re-validation.
import { validateAndLoadEnv, EnvValidationError, getPort, getRequestTimeoutMs, getShutdownDrainMs, getRunWorkerInprocess } from './config/env.js';
try {
  validateAndLoadEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    logger.fatal({ err, envName: err.envName }, 'Environment validation failed — exiting');
    process.exit(1);
  }
  throw err;
}

import { storiesRouter } from './routes/stories.js';
import { generationRouter } from './routes/generation.js';
import { exportRouter } from './routes/export.js';
import { similarityRouter } from './routes/similarity.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { eventsRouter } from './routes/events.js';

import { metricsRouter } from './routes/metrics.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { adminRouter } from './routes/admin.js';
import { publicConfigRouter } from './routes/public-config.js';
import { openapiRouter } from './routes/openapi.js';
import { authRouter } from './routes/auth.js';
import { alertsRouter } from './routes/alerts.js';
import { errorHandler, notFoundHandler, asyncMiddleware } from './middleware/error.js';
import { generalLimiter, perUserLimiter, registerLimiter, loginLimiter, sessionLimiter, healthLimiter } from './middleware/rate-limit.js';
import { requestIdMiddleware, requestLogger } from './middleware/request-id.js';
import { prisma, testConnection } from './database/prisma.js';
import { closeQueues, getRedisUrl } from './queue/index.js';
import { closePubSub } from './queue/redis-pubsub.js';
import { closeSharedRedis } from './lib/shared-redis.js';
import { createStoryWorker } from './queue/workers/worker-factory.js';
import { logger } from './services/logger.js';
import { apiAuthMiddleware } from './middleware/api-auth.js';
import { jwtMiddleware } from './middleware/jwt.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { validateIdParam } from './middleware/validate-params.js';

// ---------- App ----------

const app = express();
const PORT = getPort();

// Default to false in all environments. Running an in-process worker alongside
// the HTTP server blocks the event loop during story generation (minutes, all AI calls),
// which stalls SSE progress events and health checks. Explicitly set RUN_WORKER_INPROCESS=true
// only for development with a single process.
const RUN_WORKER_INPROCESS = getRunWorkerInprocess();
if (process.env.NODE_ENV === 'production' && RUN_WORKER_INPROCESS) {
  logger.error('RUN_WORKER_INPROCESS=true is not allowed in production — worker must run in a separate container');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

// C3 — Request idle timeout middleware. A slow client can hold a connection
// open indefinitely, consuming a connection slot from the pool and preventing
// fair access. `req.setTimeout()` fires when the underlying socket has been
// IDLE for the configured duration — an actively streaming response (e.g. SSE)
// keeps the socket active and won't trigger this timeout. This is a guard
// against clients that connect but never send a complete request body.
// The timeout is configurable via REQUEST_TIMEOUT_MS env var (default 5 min).
// Uses lazy getter so env validation runs before the value is read.
const REQUEST_TIMEOUT_MS = getRequestTimeoutMs();
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timed out' });
    }
    req.destroy();
  });
  next();
});

app.use(requestIdMiddleware);
app.use(requestLogger);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xDnsPrefetchControl: { allow: false },
  })
);

// CRIT-14: Scope the CDN script-src relaxation to /api/docs only.
// The docs UI loads Redoc from cdn.jsdelivr.net. Applying this
// globally would weaken CSP for all backend responses; scoping it to
// the docs path limits the attack surface to the admin-only docs UI.
app.use(
  '/api/docs',
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        objectSrc: ["'none'"],
      },
    },
  })
);
// CORS_ORIGINS resolved in the start() function after env validation to avoid
// reading env before validateAndLoadEnv() runs. See start() for the value.
let _corsOrigins: ReturnType<typeof _computeCorsOrigins>;
function _computeCorsOrigins(): string | string[] | undefined {
  const originsRaw = process.env.CORS_ORIGINS;
  if (!originsRaw && process.env.NODE_ENV === 'production') {
    logger.error('CORS_ORIGINS environment variable is required in production');
    return undefined;
  }
  const origins = (originsRaw || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length === 1 ? origins[0] : origins;
}

app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  const allowed = _corsOrigins;
  if (origin && allowed) {
    const origins = Array.isArray(allowed) ? allowed : [allowed];
    if (origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID, Authorization, X-CSRF-Token, X-Requested-With, Accept, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
// AUDIT-009 + MED-1: Depth-limited JSON parsing — checks nesting depth on the raw
// buffer (via express.json's `verify` callback) BEFORE constructing the JS object.
// A 1000-level nested array would exhaust memory during JSON.parse even with a
// 10mb byte limit. The verify callback runs after the buffer is read but before
// JSON.parse, so a deeply nested payload is rejected without ever allocating the
// deep JS object tree. The character-level scan handles escaped characters inside
// strings so `{"foo":"{({[}"}` doesn't false-positive.
function checkJsonDepth(buf: Buffer, limit: number): void {
  if (buf.length === 0) return;
  let depth = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === 34) {
      i++;
      while (i < buf.length) {
        if (buf[i] === 92) { i += 2; continue; }
        if (buf[i] === 34) break;
        i++;
      }
      continue;
    }
    if (ch === 123 || ch === 91) { depth++; if (depth > limit) throw Object.assign(new Error('JSON nesting depth exceeded'), { status: 413 }); }
    if (ch === 125 || ch === 93) depth--;
  }
}
app.use(
  express.json({
    limit: '10mb',
    strict: true,
    verify: (_req, _res, buf: Buffer) => checkJsonDepth(buf, 32),
  })
);
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// SSE endpoint: query string carries auth, not body. Cap URI to prevent
// accidental overload from malformed URLs (does not affect body size limits).
// L10: apply the URI-length cap on BOTH API prefixes (the Express prefix
// match did not cover /api/v1).
for (const p of ['/api', '/api/v1']) {
  app.use(`${p}/stories/generate`, (req, _res, next) => {
    if (req.url.length > 2048) {
      _res.status(414).json({ error: 'URI too long' });
      return;
    }
    next();
  });
}

// Health check — no auth, but apply a generous rate limit for load balancer probes.
app.use('/api/health', healthLimiter);
app.use('/api/health', healthRouter);

// Public config — no auth (frontend fetches config on startup).
app.use('/api', publicConfigRouter);

// Alertmanager webhook receiver — separate bearer-token auth, not user/admin auth.
app.use('/api/alerts', alertsRouter);

// Fix #26: OpenAPI 3.1 spec at GET /api/docs (JSON) and GET /api/docs/ui (Redoc).
// Admin-only — enforced inside openapiRouter via verifyAdminAuth.
app.use('/api/docs', openapiRouter);

// API version prefix array — used for all route mounts below.
const API_PREFIXES = ['/api', '/api/v1'];

// Auth routes — no jwtMiddleware (login/logout don't need auth).
// Mount per-endpoint rate limiters for brute-force protection.
// Each endpoint type has its own budget so a burst on one (e.g. rapid
// GET /me polling) can't exhaust the budget for another (e.g. login).
for (const prefix of API_PREFIXES) {
  app.use(`${prefix}/auth/register`, registerLimiter);
  app.use(`${prefix}/auth/login`, loginLimiter);
  // Auth route handlers (register/login/refresh) issue their own XSRF-TOKEN
  // cookies explicitly. A separate middleware here would double-issue the
  // cookie, leaving clients with two token values and breaking double-submit
  // validation (the jar keeps the last value while tests read the first).
  app.use(`${prefix}/auth`, sessionLimiter, authRouter);
}

// API authentication (SSE HMAC only) + JWT auth + global rate limiting on /api routes.
// validateIdParam inspects req.path directly (no manual path registration)
// and runs BEFORE csrfMiddleware so invalid IDs return 400, not 403.
for (const prefix of API_PREFIXES) {
  app.use(prefix, apiAuthMiddleware);
  app.use(prefix, asyncMiddleware(jwtMiddleware));
  app.use(prefix, validateIdParam);
  app.use(prefix, csrfMiddleware);
  app.use(prefix, generalLimiter);
  app.use(prefix, perUserLimiter);
}

// Routes (order matters: most specific first).
// Mount under both /api and /api/v1 for versioning support.
// New endpoints should be added under /api/v1 only; /api is maintained
// for backward compatibility during the transition period.
for (const prefix of API_PREFIXES) {
  app.use(`${prefix}/stories/generate`, eventsRouter);
  app.use(`${prefix}/stories/generate`, generationRouter);
  app.use(`${prefix}/stories/check-similarity`, similarityRouter);
  app.use(`${prefix}/stories`, exportRouter);
  app.use(`${prefix}/stories`, storiesRouter);
  app.use(`${prefix}/settings`, settingsRouter);
  app.use(`${prefix}/user-settings`, userSettingsRouter);
  app.use(`${prefix}/admin`, adminRouter);
}

// L4-METRICS-NETWORK: metrics are accessible from localhost (for
// `curl http://localhost:34567/metrics` during local debugging) and from
// private Docker networks. Compose assigns dynamic private subnets, so the
// ACL matches loopback plus RFC1918 ranges (configurable with
// METRICS_ALLOWED_CIDRS) rather than a fixed subnet. Other addresses get
// 401. The ACL is implemented in a dedicated module
// (server/metrics-acl.ts) so it can be unit-tested without spinning
// up a server.
import { metricsRequestAllowed } from './server/metrics-acl.js';

app.use('/metrics', (req, res, next) => {
  const sock = req.socket;
  const remoteIp = sock ? sock.remoteAddress : null;
  if (metricsRequestAllowed(remoteIp)) return next();
  res.status(401).json({ error: 'Metrics endpoint is restricted to the docker network and localhost' });
});
app.use('/metrics', metricsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// ---------- Bootstrap ----------

async function checkRedisVersion(): Promise<void> {
  try {
    const { createRedis } = await import('./lib/create-redis.js');
    const check = createRedis(getRedisUrl(), { maxRetriesPerRequest: 3 });
    await check.connect();
    const info = await check.info('server');
    const m = info.match(/redis_version:(\d+)\.(\d+)/);
    if (m) {
      const [major, minor] = [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
      if (major < 6 || (major === 6 && minor < 2)) {
        const msg =
          `Redis ${major}.${minor} detected. BullMQ 5.x requires Redis 6.2.0+ for BLMOVE. ` +
          `Queue state may desync under load — stalled jobs and lost events are possible. ` +
          `Refusing to start in production. Upgrade Redis to 6.2.0 or higher.`;
        if (process.env.NODE_ENV === 'production') {
          throw new Error(msg);
        }
        logger.warn({ major, minor }, msg);
      }
    }
    await check.quit();
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({ err }, 'Redis version check failed in production — refusing to start');
      throw err;
    }
    logger.warn({ err }, 'Redis unavailable — continuing in dev mode');
    // Do not exit. BullMQ and ioredis have their own retry/reconnect strategies.
    // The server starts so that operators can query health and investigate.
  }
}

/**
 * PERF-002/DATA-001: Verify the pgvector HNSW index exists on the embedding column.
 * The index is created via a raw SQL migration and cannot be expressed in Prisma DSL.
 * Running 'prisma db push' silently drops it, causing similarity queries to use the
 * lexical fallback instead. We detect this by querying pg_indexes at startup and
 * fail fast with a clear error rather than running in a degraded state.
 */
/** Discovered HNSW index name, updated by {@link checkHnswIndexExists}. */
let hnswIndexName: string | undefined;

async function checkHnswIndexExists(): Promise<string | undefined> {
  try {
    // Query by index definition (indexdef) instead of index name pattern matching.
    // Using LIKE on index names is fragile — a migration rename silently breaks the check.
    // Instead, find any index on the 'stories' table whose definition contains 'hnsw'.
    const result = await prisma().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'stories'
        AND indexdef ILIKE '%hnsw%'
      LIMIT 1
    `;
    if (result.length === 0) {
      const msg =
        'HNSW index on stories.embedding not found. ' +
        'Run `npx prisma migrate deploy` instead of `npx prisma db push`. ' +
        'Without the HNSW index, similarity detection silently degrades to slow lexical fallback.';
      if (process.env.NODE_ENV === 'production') {
        throw new Error(msg);
      }
      logger.warn({}, msg);
      hnswIndexName = undefined;
      return hnswIndexName;
    }

    const { indexname, indexdef } = result[0]!;
    hnswIndexName = indexname;
    logger.info({ indexName: indexname }, 'pgvector HNSW index verified present');

    // REL-005: Verify the HNSW index was created with vector(1024), not 4096.
    // pgvector HNSW has a HARD 2000-dim limit. A previous migration used 4096
    // and silently failed on every cold start with "column cannot have more
    // than 2000 dimensions for hnsw index", leaving the migration in a stuck
    // state and the backend in a crash loop. This check parses the index
    // expression and refuses to start in production if the dimension is wrong.
    const expectedDim = 1024;
    const dimMatch = indexdef.match(/vector\((\d+)\)/);
    const actualDim = dimMatch ? parseInt(dimMatch[1]!, 10) : 0;
    if (actualDim !== expectedDim) {
      const dimMsg =
        `HNSW index dimension mismatch: expected vector(${expectedDim}) but found ` +
        `vector(${actualDim}) in "${indexdef}". pgvector HNSW has a 2000-dim hard limit. ` +
        `Update migration 20260528000002_add_pgvector_and_hnsw to use vector(${expectedDim}) ` +
        `or the actual dimension of your embedding model.`;
      if (process.env.NODE_ENV === 'production') {
        throw new Error(dimMsg);
      }
      logger.error({ indexdef, expectedDim, actualDim }, dimMsg);
    } else {
      logger.info({ dimension: actualDim, indexName: indexname }, `pgvector HNSW index dimension verified: vector(${actualDim})`);
    }
    return hnswIndexName;
  } catch (err) {
    hnswIndexName = undefined;
    if (process.env.NODE_ENV === 'production') {
      logger.error({ err }, 'HNSW index check failed in production — refusing to start');
      throw err;
    }
    logger.warn({ err }, 'HNSW index check failed — continuing in dev mode');
  }
}

async function start(): Promise<void> {
  await checkRedisVersion();

  // Fix: Compute CORS origins after env validation is complete. Previously the
  // CORS origin was computed at module load time (IIFE) before validateAndLoadEnv()
  // ran, so process.env.CORS_ORIGINS / CORS_ORIGIN was undefined in production
  // deployments where the value was loaded from .env. This caused all cross-origin
  // requests to be rejected with "Not allowed by CORS".
  _corsOrigins = _computeCorsOrigins();

  // MED-28: Verify database connectivity at startup so the server fails fast
  // if the database is unreachable, rather than serving requests that crash
  // with connection errors on the first query.
  try {
    await testConnection();
  } catch (err) {
    logger.fatal({ err }, 'Database connection failed at startup — exiting');
    throw err;
  }

  // PERF-002/DATA-001: Verify the pgvector HNSW index exists before starting.
  // If 'prisma db push' was used instead of migrations, the index is missing and
  // all similarity queries silently degrade to lexical fallback. Fail fast with a
  // clear message rather than running in a degraded state.
  hnswIndexName = await checkHnswIndexExists();

  // Fix #2: Periodic re-check every 5 minutes. The startup check covers a
  // freshly-rebuilt image, but a long-running server can lose the HNSW
  // index mid-flight (e.g. an operator runs `prisma db push` to fix a
  // schema drift, which silently drops the index). Without this re-check,
  // the server keeps serving degraded similarity results until the next
  // restart — possibly days. The re-check runs in the background with
  // `unref()` so it never blocks shutdown.
  //
  // Fix: Also REINDEX the HNSW index every 6 hours to prevent performance
  // degradation from insert/update/delete churn. HNSW supports incremental
  // updates but the Postgres implementation may not rebalance after mass
  // deletes (e.g., replaceStoryAtomically which deletes and recreates).
  // Without periodic reindexing, vector similarity query performance
  // gradually degrades as the index structure drifts from optimal.
  //
  // PERF-HNSW-OWNER: periodic HNSW re-check and REINDEX moved to the worker
  // process (queue/workers/run-worker.ts). The API process previously owned
  // these timers, paying for maintenance work in the process that must stay
  // responsive to HTTP/SSE traffic. The API still performs the one-shot
  // fail-fast startup check above (PERF-002/DATA-001) — only the recurring
  // maintenance moved.

  // In-production: worker runs in a separate container (see docker-compose worker
  // service). The Express server handles HTTP only — no story processing here.
  if (RUN_WORKER_INPROCESS) {
    const { worker } = createStoryWorker();
    logger.info({ concurrency: worker.opts.concurrency }, 'In-process worker started');
  } else {
    logger.info('Out-of-process worker mode — expecting separate worker container');
  }

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'CinematicAI Backend running');
    logger.info(`API: http://localhost:${PORT}/api`);
  });

  // Fix #15: HTTP server must drain in-flight requests before exit. The
  // previous `server.close()` resolved as soon as the listening socket
  // was closed — any active SSE or slow query was terminated mid-stream.
  // The new flow: stop accepting new connections, wait for in-flight
  // requests to finish (or the hard ceiling), then resolve.
  setupShutdown(async () => {          const DRAIN_TIMEOUT_MS = getShutdownDrainMs();
    const drainStart = Date.now();
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.warn({ err }, 'HTTP server close error during shutdown');
        resolve();
      });
      // Force-close any keep-alive connections that haven't released.
      // `closeIdleConnections` only catches idle keep-alive sockets; an
      // SSE connection that has been silent for the heartbeat interval
      // counts as idle here.
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      // Hard ceiling: if requests are still in flight after the
      // timeout, force-close them so shutdown completes.
      setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') {
          logger.warn(
            { drainMs: Date.now() - drainStart, timeoutMs: DRAIN_TIMEOUT_MS },
            'Drain timeout — force-closing remaining connections'
          );
          server.closeAllConnections();
        }
        resolve();
      }, DRAIN_TIMEOUT_MS).unref();
    });
    logger.info(
      { drainMs: Date.now() - drainStart },
      'HTTP server closed (drained)'
    );
  });
}

// ---------- Graceful shutdown ----------
// L4-SHARED-SHUTDOWN: uses the shared graceful-shutdown module so both
// server.ts and run-worker.ts share identical shutdown logic. Previously
// the two files had near-duplicate implementations that drifted over time
// (different timeout handling, different exit-code logic).

import {
  setupGracefulShutdown,
  registerShutdownHandlers,
  runShutdown,
} from './lib/graceful-shutdown.js';

// Replace the old local `setupShutdown` name with the shared import.
// The rest of the file (below) calls setupShutdown() and setupShutdown is
// now an alias for setupGracefulShutdown.
const setupShutdown = setupGracefulShutdown;

// Final cleanup runs closeQueues, closePubSub, closeSharedRedis, prisma disconnect.
const finalCleanup = async () => {
  await closeQueues();
  await closePubSub();
  await closeSharedRedis();
  await prisma().$disconnect();
};

// Register SIGTERM/SIGINT handlers through the shared module.
registerShutdownHandlers(logger, finalCleanup);

// BUG-002: unhandled rejections are logged but do NOT trigger shutdown; a
// single bad promise should not cascade into a full process restart.
// CRITICAL #6: uncaught exceptions are fatal — initiate graceful drain and
// exit so the process is not left in an undefined state. The shared shutdown
// path closes the HTTP server (with DRAIN_TIMEOUT_MS), queues, pub/sub,
// shared Redis, and disconnects Prisma.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — initiating graceful shutdown');
  void runShutdown('uncaughtException', logger, finalCleanup);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection (not shutting down)');
});

// Detect if this file is being run as the main entry point (ESM-safe).
// M6 — Use fileURLToPath + import.meta.url for reliable entry detection.
// The previous version used process.argv[1].endsWith() which failed on
// absolute paths (e.g. `node /app/dist/server.js`) and symlinks.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const isMainModule =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      // Fallback for environments where import.meta.url is not available
      return process.argv[1].endsWith('server.js') ||
        process.argv[1].endsWith('server.ts') ||
        process.argv[1].endsWith('index.js') ||
        process.argv[1].endsWith('index.ts');
    }
  })();

if (isMainModule || process.env.START_SERVER === 'true') {
  start().catch((err) => {
    logger.fatal({ err }, 'Startup failed — exiting');
    process.exit(1);
  });
}

export { app };
export default app;