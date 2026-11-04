/**
 * Standalone story generation worker entry point.
 *
 * Run as a separate process from the HTTP API server. This is the correct
 * deployment topology: it prevents HTTP request processing (especially slow
 * Prisma queries under connection pressure) from delaying BullMQ lock renewal,
 * which was causing stall → duplicate worker → lock mismatch cascade.
 *
 * Usage:
 *   node dist/queue/run-worker.js
 *
 * Or via npm script defined in package.json:
 *   npm run worker
 */

// HTTP transport: install the undici Agent with socket-level timeouts
// BEFORE any module issues a fetch. The worker process is the one that
// actually hangs in production, so this is the critical install point.
import { installHttpTransport } from '../../lib/http-transport.js';
installHttpTransport();

import { loadEnvFiles } from '../../config/load-env.js';
loadEnvFiles();

import { validateAndLoadEnv, EnvValidationError, getWorkerHealthPort } from '../../config/env.js';
try {
  validateAndLoadEnv();
} catch (err) {
  // Can't use logger here since it hasn't been imported yet
  if (err instanceof EnvValidationError) {
    process.stderr.write(`FATAL: Environment validation failed — ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// C1 — Worker healthcheck endpoint. Runs on a separate worker_thread to
// avoid event-loop starvation from BullMQ job processing. When the health
// server ran on the main thread, CPU-heavy jobs (serialization, AI response
// parsing, JSON processing) often saturated the event loop, causing the
// HTTP request handler to never fire within Docker's 5-second healthcheck
// timeout — making the worker appear unhealthy even while processing jobs.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { moduleDir } from '../../lib/module-path.js';
import { logger as healthLogger } from '../../services/logger.js';
import { isShutdownInitiated } from '../../lib/graceful-shutdown.js';

const __dirname = moduleDir(import.meta.url);
const HEALTH_PORT = getWorkerHealthPort();
const MAX_HEALTH_RESTARTS = 5;
// M17: reset the restart counter after a stable window so crashes spread
// over weeks don't accumulate into a forced exit (previously cumulative for
// the entire process lifetime).
const HEALTH_RESTART_DECAY_MS = 10 * 60 * 1000;
let healthWorker: Worker | null = null;
let healthRestartCount = 0;
let healthRestartDecayTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRestartDecay(): void {
  if (healthRestartDecayTimer) clearTimeout(healthRestartDecayTimer);
  healthRestartDecayTimer = setTimeout(() => {
    healthRestartCount = 0;
    healthRestartDecayTimer = null;
  }, HEALTH_RESTART_DECAY_MS);
  healthRestartDecayTimer.unref();
}

function startHealthWorker(): void {
  if (isShutdownInitiated()) return;
  try {
    healthWorker = new Worker(path.join(__dirname, '..', '..', 'lib', 'health-server.js'), {
      env: { ...process.env, WORKER_HEALTH_PORT: String(HEALTH_PORT) },
    });
  } catch (err) {
    healthLogger.fatal({ err }, 'Failed to spawn health server worker thread');
    process.exit(1);
  }

  healthWorker.on('error', (err) => {
    healthLogger.error({ err }, 'Health server worker thread crashed');
  });

  healthWorker.on('exit', (code) => {
    // If we are shutting down, the thread exit is expected and we should not
    // restart it. If it exits non-zero outside of shutdown, restart with a
    // bounded number of retries; otherwise the orchestrator will see the pod as
    // permanently unhealthy (no health endpoint) while the worker continues to
    // process jobs.
    if (isShutdownInitiated()) return;

    if (code !== 0) {
      if (healthRestartCount >= MAX_HEALTH_RESTARTS) {
        healthLogger.fatal(
          { exitCode: code, restartCount: healthRestartCount },
          'Health server worker thread exited fatally; max restarts exceeded'
        );
        process.exit(1);
      }
      healthRestartCount += 1;
      scheduleRestartDecay();
      healthLogger.warn(
        { exitCode: code, restartCount: healthRestartCount },
        'Health server worker thread exited; restarting'
      );
      const delayMs = 1000 * Math.min(healthRestartCount, 5);
      setTimeout(() => startHealthWorker(), delayMs).unref();
    }
  });

  healthLogger.info({ port: HEALTH_PORT, thread: 'worker_thread' }, 'Health server started on dedicated thread');
}

startHealthWorker();

// L4-WORKER-METRICS: register Prometheus metrics in the worker
// process. The worker is the process that actually issues the AI
// calls during a story generation; the backend's metrics counters
// were always 0 before this change because the backend doesn't make
// AI calls directly (except for similarity / single-scene PATCH).
// wireWorkerAIMetrics() hooks the AI client's onRequestStart /
// onRequestSuccess / onRequestFailure callbacks to the worker's
// prom-client Registry.
import { wireWorkerAIMetrics } from './worker-metrics.js';
wireWorkerAIMetrics();

// L4-WORKER-METRICS: serve the worker's prom-client Registry from the
// main thread. Metrics counters are incremented in this thread; the
// health server runs in a separate worker_thread and cannot see them.
import { startWorkerMetricsServer } from './metrics-server.js';
// M17: keep the handle so graceful shutdown can close the port.
const metricsServer = startWorkerMetricsServer();

import {
  closeQueues,
  closeBackgroundQueues,
  getStoryQueue,
  getStoryDlq,
  getBackgroundSeoQueue,
  getBackgroundEmbeddingQueue,
  getBackgroundDlq,
} from '../../queue/index.js';
import { closePubSub } from '../../queue/redis-pubsub.js';
import { closeSharedRedis } from '../../lib/shared-redis.js';
// PERF-HNSW-OWNER: periodic HNSW index maintenance lives in the worker
// process. The API process previously ran these timers, so REINDEX
// CONCURRENTLY (an IO-heavy maintenance statement) could fire inside the
// process serving HTTP/SSE traffic. The worker already owns DB-bound
// background work; cleanupOrphanedGenerationLogs below follows the same
// pattern.
import { prisma } from '../../database/prisma.js';
import { createStoryWorker } from './worker-factory.js';
import { createBackgroundSeoWorker } from './background-seo.worker.js';
import { createBackgroundEmbeddingWorker } from './background-embedding.worker.js';
import { logger } from '../../services/logger.js';
import { cleanupOrphanedGenerationLogs } from '../../database/prisma-storage.js';
import type { Queue } from 'bullmq';

// L4-SHARED-SHUTDOWN: uses the shared graceful-shutdown module so both
// server.ts and run-worker.ts share identical shutdown logic. Previously
// the two files had near-duplicate implementations that drifted over time
// (different timeout handling, different exit-code logic, the worker had a
// `process.exit()` with no exit code while server.ts properly set exitCode).
import {
  setupGracefulShutdown,
  registerShutdownHandlers,
} from '../../lib/graceful-shutdown.js';

const setupShutdown = setupGracefulShutdown;

// BUG-002: unhandled rejection / uncaught exception in a single job MUST NOT
// tear down the whole worker. BullMQ already isolates job failures — when one
// throws, BullMQ's processor rejects the job and moves on. Triggering a full
// shutdown on any unhandled rejection meant a stray Prisma timeout (e.g.
// from a brief connection-pool stall) would crash the entire pipeline and
// stall every queued job. Log loudly, but keep serving.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection in worker (not shutting down)');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception in worker — exiting to avoid corrupt state');
  // Uncaught exceptions can leave the process in an inconsistent state
  // (open DB transactions, half-processed jobs). Exit so the orchestrator
  // (Docker/Kubernetes/systemd) restarts with a clean slate.
  process.exit(1);
});

// Register SIGTERM/SIGINT handlers through the shared module.
// Final cleanup terminates the health worker and closes queues/Redis/DB.
registerShutdownHandlers(logger, async () => {
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        healthWorker?.terminate().then(() => resolve(), () => resolve());
      }),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          logger.warn('Health worker terminate did not complete within 5s — continuing');
          resolve();
        }, 5_000).unref()
      ),
    ]);
  } catch {
    // non-fatal
  }
  await closeQueues();
  // M19: closeQueues already closes the story DLQ — drop the redundant
  // double close.
  await closePubSub();
  await closeSharedRedis();
  // M17: close the metrics server so the port releases on in-process restarts.
  await new Promise<void>((resolve) => {
    metricsServer.close(() => resolve());
    setTimeout(resolve, 2_000).unref();
  });
});

// ---------- Start ----------

const { worker, closeDlq: _closeDlq } = createStoryWorker();
const backgroundSeoWorker = createBackgroundSeoWorker();
const backgroundEmbeddingWorker = createBackgroundEmbeddingWorker();

logger.info(
  { concurrency: worker.opts.concurrency, lockDuration: worker.opts.lockDuration },
  'Standalone story worker started'
);
logger.info('Background SEO and embedding workers started');

setupShutdown(async () => {
  await worker.close(false);
  await backgroundSeoWorker.close(false);
  await backgroundEmbeddingWorker.close(false);
  // M19: closeDlq() and closeBackgroundQueues() both ultimately close the same
  // underlying queues as closeQueues() in the shared shutdown handler above;
  // keep the worker-specific close for the background queues only.
  await closeBackgroundQueues();
  logger.info('All workers closed');
});

// Periodic cleanup — every 24 hours.
// 1. Cleans up orphaned generation logs from the database.
// 2. Cleans old completed/failed BullMQ jobs (does NOT drain waiting jobs).
// H7: Previously this called flushAllQueues() which calls q.drain() —
// silently discarding ALL waiting/delayed jobs. During backlog recovery
// after an outage, this could discard dozens of queued user jobs. Now we
// only clean old completed/failed jobs via q.clean(), which preserves
// waiting/delayed jobs.
const CLEANUP_TIMEOUT_MS = 30_000;

const PERIODIC_CLEANUP_QUEUES: { name: string; getQueue: () => Queue }[] = [
  { name: 'story-generation', getQueue: getStoryQueue },
  { name: 'story-generation-dlq', getQueue: getStoryDlq },
  { name: 'background-seo', getQueue: getBackgroundSeoQueue },
  { name: 'background-embedding', getQueue: getBackgroundEmbeddingQueue },
  { name: 'background-dlq', getQueue: getBackgroundDlq },
];

async function withCleanupTimeout<T>(name: string, promise: Promise<T>): Promise<T> {
  // M19: capture the timer handle and clear it when the promise wins the
  // race — previously the losing 30s timer stayed pending, keeping the event
  // loop alive after each daily cleanup.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        timer = setTimeout(
          () => reject(new Error(`Queue cleanup '${name}' timed out after ${CLEANUP_TIMEOUT_MS}ms`)),
          CLEANUP_TIMEOUT_MS
        )
      ),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function periodicQueueCleanup(): Promise<void> {
  for (const { name, getQueue } of PERIODIC_CLEANUP_QUEUES) {
    let q: Queue;
    try {
      q = getQueue();
    } catch (err) {
      logger.warn({ queue: name, err }, 'Worker periodic cleanup — failed to get queue instance');
      continue;
    }
    try {
      // Clean completed older than 1h and failed older than 24h
      await withCleanupTimeout(name, q.clean(3600_000, 1000, 'completed'));
      await withCleanupTimeout(name, q.clean(86400_000, 1000, 'failed'));
    } catch (err) {
      logger.warn({ queue: name, err }, 'Worker periodic cleanup — queue clean failed');
    }
  }
}

// C2 FIX (DLQ TTL): The story and background DLQs have no consuming worker, so
// entries sit in the 'waiting' state forever — q.clean('completed'/'failed')
// never touches them and the DLQ grew without bound. Purge 'waiting' DLQ
// entries older than 7 days (matching the documented 7-day retention window)
// so dead-letter entries expire instead of accumulating indefinitely.
const DLQ_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DLQ_QUEUES: { name: string; getQueue: () => Queue }[] = [
  { name: 'story-generation-dlq', getQueue: getStoryDlq },
  { name: 'background-dlq', getQueue: getBackgroundDlq },
];

async function purgeExpiredDlqEntries(): Promise<void> {
  for (const { name, getQueue } of DLQ_QUEUES) {
    let q: Queue;
    try {
      q = getQueue();
    } catch (err) {
      logger.warn({ queue: name, err }, 'Worker periodic cleanup — failed to get DLQ instance');
      continue;
    }
    try {
      const removed = await withCleanupTimeout(name, q.clean(DLQ_ENTRY_TTL_MS, 1000, 'wait'));
      if (removed.length > 0) {
        logger.info({ queue: name, removed: removed.length }, 'Worker periodic cleanup — expired DLQ entries purged');
      }
    } catch (err) {
      logger.warn({ queue: name, err }, 'Worker periodic cleanup — DLQ purge failed');
    }
  }
}

const cleanupInterval = setInterval(async () => {
  try {
    const logsCleared = await cleanupOrphanedGenerationLogs(30);
    if (logsCleared > 0) {
      logger.info({ logsCleared }, 'Worker periodic cleanup — orphaned logs removed');
    }
    await periodicQueueCleanup();
    await purgeExpiredDlqEntries();
    logger.info('Worker periodic cleanup — old completed/failed jobs cleaned');
  } catch (err) {
    logger.warn({ err }, 'Worker periodic cleanup failed');
  }
}, 24 * 60 * 60 * 1000);
cleanupInterval.unref();
// Fix #15: clear the cleanup interval on shutdown so it doesn't keep
// the event loop alive after the worker has logically stopped.
setupShutdown(async () => clearInterval(cleanupInterval));

// PERF-HNSW-OWNER: periodic HNSW maintenance (moved here from server.ts).
// The worker process owns DB-bound background work; the API process only
// performs the one-shot fail-fast startup check (PERF-002/DATA-001).
//
// Re-check every 30 minutes: a long-running deployment can lose the HNSW
// index mid-flight (e.g. an operator runs `prisma db push`, which silently
// drops it). Without a re-check the pipeline keeps using degraded lexical
// similarity until restart. Reindex every 6 hours to reverse HNSW structure
// drift after mass deletes (replaceStoryAtomically deletes and recreates).
const HNSW_RECHECK_MS = 30 * 60 * 1000;
const HNSW_REINDEX_MS = 6 * 60 * 60 * 1000;
let hnswIndexName: string | undefined;

async function checkHnswIndexExists(): Promise<string | undefined> {
  try {
    // Query by indexdef instead of index-name LIKE — a migration rename
    // silently breaks name matching (same approach as server.ts startup check).
    const result = await prisma().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'stories'
        AND indexdef ILIKE '%hnsw%'
      LIMIT 1
    `;
    if (result.length === 0) {
      logger.warn('HNSW index on stories.embedding not found — similarity degrades to lexical fallback');
      hnswIndexName = undefined;
      return hnswIndexName;
    }
    const { indexname } = result[0]!;
    hnswIndexName = indexname;
    return hnswIndexName;
  } catch (err) {
    hnswIndexName = undefined;
    logger.warn({ err }, 'Worker HNSW index re-check failed (non-critical)');
    return undefined;
  }
}

const hnswRecheckInterval = setInterval(() => {
  void checkHnswIndexExists();
}, HNSW_RECHECK_MS);
hnswRecheckInterval.unref();

const hnswReindexInterval = setInterval(async () => {
  try {
    const indexName = hnswIndexName;
    if (!indexName) {
      logger.warn('HNSW index name unknown — skipping periodic reindex');
      return;
    }
    // Defense in depth: only interpolate identifiers that match Postgres's
    // unquoted identifier grammar. The value comes from pg_indexes, but a
    // strict regex prevents accidental SQL injection if that source ever
    // returns a crafted name.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(indexName)) {
      logger.warn({ indexName }, 'HNSW index name is not a valid identifier — skipping periodic reindex');
      return;
    }
    await prisma().$executeRawUnsafe(`REINDEX INDEX CONCURRENTLY "${indexName}"`);
    logger.info({ indexName }, 'HNSW index reindexed (worker periodic)');
  } catch (err) {
    logger.warn({ err }, 'Worker HNSW reindex failed (non-critical)');
  }
}, HNSW_REINDEX_MS);
hnswReindexInterval.unref();

// Discover the index name once at worker start so the first reindex window
// has a valid name even if the recheck has not fired yet.
void checkHnswIndexExists();

setupShutdown(async () => {
  clearInterval(hnswRecheckInterval);
  clearInterval(hnswReindexInterval);
});
