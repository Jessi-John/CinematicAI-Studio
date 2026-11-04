/**
 * Redis Pub/Sub for job progress events.
 *
 * Survives server restarts. Uses a small pool of subscriber connections per job.
 * All Redis operations are wrapped with retry logic for transient failures
 * (connection drops, timeouts, Redis overload).
 */

import { getRedisUrl } from './index.js';
import { sleep } from '../lib/sleep.js';
import { logger } from '../services/logger.js';
import { isRetriableError, calculateDelay } from '../lib/retry.js';
import type { Redis } from 'ioredis';
import { createRedis } from '../lib/create-redis.js';

// LAZY-001: Module-level Redis instances defer connection until first use.
// This prevents real Redis connections in test environments where ioredis is mocked.
let _publisher: Redis | null = null;
function getPublisher(): import('ioredis').Redis {
  if (!_publisher) {
    _publisher = createRedis(getRedisUrl(), {
      maxRetriesPerRequest: 3,
    });
    _publisher.on('error', (err: Error) => logger.warn({ err }, 'Pub/sub publisher error'));
  }
  return _publisher;
}

// Fix #20: Maximum concurrent subscriber connections (LRU eviction when full).
// The previous hard-coded 200 was too low for ~50 concurrent users × 4 tabs
// each. The new default is 1000, configurable via `SSE_MAX_SUBSCRIBERS`.
// M19: compute lazily — the IIFE read the env at IMPORT time, contradicting
// the lazy-env pattern used everywhere else in this module.
function getEnvMaxSubscribers(): number {
  const v = parseInt(process.env.SSE_MAX_SUBSCRIBERS ?? '1000', 10);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}
export const MAX_SUBSCRIBER_CONNECTIONS = getEnvMaxSubscribers();
// REL-004: TTL for individual connections (30 minutes)
export const SUBSCRIBER_CONNECTION_TTL_MS = 30 * 60 * 1000;

interface TrackedConnection {
  redis: Redis;
  lastUsed: number; // Date.now() timestamp
  // REL-017: Store the message handler so it can be removed on evict.
  // Without this, the handler closure (capturing Express 'res') remains registered
  // on a disconnected Redis subscriber, blocking GC of the Response object.
  handler?: (channel: string, message: string) => void;
}

const subscriberConnections = new Map<string, TrackedConnection>();

// REL-018: In-flight subscriber creation promises. Prevents concurrent
// `subscribeToJobEvents` calls for the same jobId from creating duplicate
// Redis subscriber connections and double-subscribing to channels.
const subscriberCreationPromises = new Map<string, Promise<TrackedConnection>>();

let closing = false; // REL-006: prevents new connections during shutdown

export const CHANNELS = {
  STORY_PROGRESS: 'story:progress',
  STORY_COMPLETE: 'story:complete',
  STORY_ERROR: 'story:error',
} as const;

export interface StoryProgressEvent {
  jobId: string;
  type: 'progress' | 'complete' | 'error';
  progress: number;
  stage?: string;
  message?: string;
  data?: unknown;
  timestamp: number;
  requestId?: string;
}

// ---------- Retry helpers ----------

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 200
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1 && isRetriableError(err)) {
        const delay = calculateDelay(baseDelayMs, attempt, 5000);
        logger.warn({ operation, attempt: attempt + 1, delayMs: delay, err }, `Redis ${operation} failed, retrying`);
        await sleep(delay);
        continue;
      }
      logger.warn({ operation, err }, `Redis ${operation} failed permanently`);
      break;
    }
  }
  if (lastError !== undefined) throw lastError;
  throw new Error(`Redis ${operation} failed after ${retries} attempts`);
}

// REL-004: Evict the oldest connection (FIFO)
function evictOldestConnection(): void {
  const oldest = subscriberConnections.keys().next().value;
  if (oldest) evictSubscriberConnection(oldest);
}

// REL-004/REL-005: Single gateway for removing subscriber connections.
// Removes the message handler (releasing Express 'res' from the closure chain)
// before disconnecting so GC can collect the Response object.
function evictSubscriberConnection(jobId: string): void {
  const tracked = subscriberConnections.get(jobId);
  if (!tracked) return;
  if (tracked.handler) {
    tracked.redis.removeListener('message', tracked.handler);
  }
  tracked.redis.disconnect();
  subscriberConnections.delete(jobId);
}

// REL-004: Periodic TTL watchdog — evicts connections idle for >30 minutes.
// Fix: .unref() prevents the interval from keeping the Node.js process alive.
// Without this, the server won't exit naturally when no active connections exist,
// which interferes with container orchestrators that rely on natural process exit.
const _ttlWatchdog = setInterval(() => {
  const now = Date.now();
  for (const [jobId, tracked] of subscriberConnections) {
    if (now - tracked.lastUsed > SUBSCRIBER_CONNECTION_TTL_MS) {
      logger.info({ jobId }, 'Evicting stale subscriber connection (TTL expired)');
      evictSubscriberConnection(jobId);
    }
  }
}, 5 * 60 * 1000);
_ttlWatchdog.unref();

async function getSubscriberConnection(jobId: string): Promise<TrackedConnection> {
  // REL-006: Prevent new connections during shutdown
  if (closing) {
    throw new Error('Pub/sub is closing; cannot create new subscriber connection');
  }

  let tracked = subscriberConnections.get(jobId);
  if (tracked) {
    tracked.lastUsed = Date.now();
    return tracked;
  }

  // REL-018: Reuse an in-flight creation promise for this jobId so two
  // concurrent SSE requests for the same job share one connection.
  let creation = subscriberCreationPromises.get(jobId);
  if (creation) {
    return creation;
  }

  creation = (async (): Promise<TrackedConnection> => {
    try {
      // Recheck under the creation lock in case another caller finished first.
      tracked = subscriberConnections.get(jobId);
      if (tracked) {
        tracked.lastUsed = Date.now();
        return tracked;
      }

      // REL-004: Evict oldest if at capacity before adding a new one.
      // M19: evaluate the cap lazily so SSE_MAX_SUBSCRIBERS set after import
      // (or in tests) takes effect.
      if (subscriberConnections.size >= getEnvMaxSubscribers()) {
        evictOldestConnection();
      }

      const conn = createRedis(getRedisUrl(), {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 100, 3000),
        lazyConnect: true,
      });

      // REL-005/REL-007: Attach error handler BEFORE connect to avoid missing errors during ready wait
      conn.on('error', (err: Error) => {
        logger.warn({ jobId, err }, 'Pub/sub subscriber error');
        evictSubscriberConnection(jobId);
      });
      await conn.connect().catch((err: Error) => {
        logger.warn({ jobId, err }, 'Pub/sub subscriber connect failed');
        evictSubscriberConnection(jobId);
        throw err;
      });

      tracked = { redis: conn, lastUsed: Date.now() };
      subscriberConnections.set(jobId, tracked);
      return tracked;
    } finally {
      subscriberCreationPromises.delete(jobId);
    }
  })();

  subscriberCreationPromises.set(jobId, creation);
  return creation;
}

export async function publishProgress(event: StoryProgressEvent): Promise<void> {
  const channel =
    event.type === 'complete'
      ? CHANNELS.STORY_COMPLETE
      : event.type === 'error'
        ? CHANNELS.STORY_ERROR
        : CHANNELS.STORY_PROGRESS;
  await withRetry('publish', () =>
    getPublisher().publish(channel, JSON.stringify(event))
  );
}

export async function subscribeToJobEvents(
  jobId: string,
  onEvent: (event: StoryProgressEvent) => void,
  onEnd?: () => void
): Promise<{ unsubscribe: () => void }> {
  const tracked = await getSubscriberConnection(jobId);
  let subscriber = tracked.redis;
  let ended = false;

  const handler = (_channel: string, message: string) => {
    if (ended) return;
    // REL-004: Touch lastUsed on every received event so the TTL watchdog
    // doesn't evict the connection while events are still flowing for a
    // long-running job. Without this, the connection is evicted 30 minutes
    // after creation, before the ~40-minute generation completes, and the
    // terminal 'complete' event is never received by the SSE client.
    const entry = subscriberConnections.get(jobId);
    if (entry) entry.lastUsed = Date.now();
    try {
      const event = JSON.parse(message) as StoryProgressEvent;
      if (event.jobId !== jobId) return;
      onEvent(event);
      if (event.type === 'complete' || event.type === 'error') {
        ended = true;
        subscriber.unsubscribe().catch(() => undefined);
        // Fix: Call onEnd synchronously BEFORE evictSubscriberConnection so the
        // SSE response socket is closed before the Redis subscriber connection is
        // torn down. Previously, evictSubscriberConnection ran first (removing the
        // message handler and disconnecting Redis), then onEnd ran 50ms later via
        // setTimeout. If the SSE client's req.on('close') fired during that 50ms
        // window, the cleanup code saw `ended = true` and returned without calling
        // res.end() — the response socket was never properly closed by the server,
        // leading to zombie response objects and socket exhaustion on busy servers.
        onEnd?.();
        evictSubscriberConnection(jobId);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse pub/sub message');
    }
  };

  // REL-007: Wait for subscriber to be ready before subscribing.
  // M17: If the initial connect() failed, the connection was evicted. Retrying
  // on the same dead Redis instance would hang forever (it will never fire
  // 'ready'/'error'/'close' again). Create a NEW Redis instance for the retry.
  if (subscriber.status !== 'ready') {
    // Check if the current subscriber is in a bad state (connecting/failed/closed)
    // and replace it with a fresh connection before retrying.
    if (subscriber.status === 'end' || subscriber.status === 'wait') {
      const oldTracked = subscriberConnections.get(jobId);
      if (oldTracked) {
        try { oldTracked.redis.disconnect(); } catch { /* already disconnected */ }
      }
      // Create a fresh Redis instance for the retry
      const freshConn = createRedis(getRedisUrl(), {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 100, 3000),
        lazyConnect: true,
      });
      freshConn.on('error', (err: Error) => {
        logger.warn({ jobId, err }, 'Pub/sub retry subscriber error');
        evictSubscriberConnection(jobId);
      });
      await freshConn.connect().catch((err: Error) => {
        logger.warn({ jobId, err }, 'Pub/sub retry subscriber connect failed');
        evictSubscriberConnection(jobId);
        throw err;
      });
      subscriberConnections.set(jobId, { redis: freshConn, lastUsed: Date.now() });
      subscriber = freshConn;
    }
    await withRetry('subscriber connect', () =>
      new Promise<void>((resolve, reject) => {
        // M19: detach listeners from failed attempts so retries don't
        // accumulate once() handlers on the same connection.
        const cleanup = (): void => {
          subscriber.removeAllListeners('ready');
          subscriber.removeAllListeners('error');
          subscriber.removeAllListeners('close');
        };
        subscriber.once('ready', () => { cleanup(); resolve(); });
        subscriber.once('error', (err) => { cleanup(); reject(err); });
        subscriber.once('close', () => {
          cleanup();
          reject(new Error('Subscriber connection closed before ready'));
        });
      })
    );
  }
  subscriber.on('message', handler);
  // REL-017: Store handler so evictSubscriberConnection can remove it before disconnect.
  // Without this, the handler closure (capturing Express 'res') would remain registered
  // on the disconnected subscriber, blocking GC of the Response object.
  const currentTracked = subscriberConnections.get(jobId);
  if (currentTracked) {
    currentTracked.handler = handler;
  }
  // M19: if subscribe() ultimately fails, evict the connection and its handler
  // immediately instead of leaking them until the 30-minute TTL watchdog.
  try {
    await withRetry('subscribe', () =>
      subscriber.subscribe(CHANNELS.STORY_PROGRESS, CHANNELS.STORY_COMPLETE, CHANNELS.STORY_ERROR)
    );
  } catch (err) {
    evictSubscriberConnection(jobId);
    throw err;
  }

  return {
    unsubscribe: () => {
      if (ended) return;
      ended = true;
      subscriber.removeListener('message', handler);
      subscriber.unsubscribe().catch(() => undefined);
      evictSubscriberConnection(jobId);
    },
  };
}

// ---------- Job state persistence ----------

let _stateStore: Redis | null = null;
function getStateStore(): Redis {
  if (!_stateStore) {
    _stateStore = createRedis(getRedisUrl(), {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });
    _stateStore.on('error', (err: Error) => logger.warn({ err }, 'Job state store error'));
  }
  return _stateStore;
}

export async function setJobState(
  jobId: string,
  state: Record<string, unknown>,
  ttlSeconds = 86400 * 7
): Promise<void> {
  await withRetry('setex', () =>
    getStateStore().setex(`job:${jobId}:state`, ttlSeconds, JSON.stringify(state))
  );
}

export async function getJobState(
  jobId: string
): Promise<Record<string, unknown> | null> {
  const data = await withRetry('get', () =>
    getStateStore().get(`job:${jobId}:state`)
  );
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, jobId }, 'Corrupt job state in Redis; treating as missing');
    return null;
  }
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  const state = await getJobState(jobId);
  if (!state) {
    await setJobState(jobId, { status: 'failed', error, failedAt: Date.now() });
    return;
  }
  state.status = 'failed';
  state.error = error;
  state.failedAt = Date.now();
  await setJobState(jobId, state);
}

/**
 * Delete any cached candidate story for a job. Called when a regenerate
 * pipeline times out — the partial candidate in Redis is no longer valid
 * and should not be left orphaned.
 */
export async function deleteJobCandidate(jobId: string): Promise<void> {
  try {
    // H7: Delete the candidate AND every stage-done flag (all attempts), so a
    // timed-out pipeline leaves no checkpoints that a retry could replay.
    const stageFlags = ['uniqueness', 'blueprint', 'character_bible', 'world_bible', 'episodes']
      .flatMap((s) => [`job:${jobId}:stage:${s}:done`]);
    await getStateStore().del(`job:${jobId}:candidate:v1`, ...stageFlags);
  } catch (err) {
    logger.warn({ err, jobId }, 'Failed to delete job candidate from Redis');
  }
}

// REL-006: Close pub/sub with proper synchronization.
// Subscribers are disconnected first (they may have pending subscriptions),
// then publisher and stateStore. Uses a simple flag + yield pattern.
export async function closePubSub(): Promise<void> {
  // Set closing flag BEFORE any await to prevent new connections.
  // getSubscriberConnection checks `if (closing)` at the start.
  closing = true;

  // Yield once so any in-flight getSubscriberConnection calls that already
  // passed the `if (closing)` check but haven't created a connection yet
  // can complete before we start disconnecting.
  await new Promise<void>((r) => setImmediate(r));

  // REL-018: Wait for any in-flight subscriber creation promises so a newly
  // created connection is not left behind after we clear the map.
  await Promise.all(
    Array.from(subscriberCreationPromises.values()).map((p) =>
      p.catch(() => undefined)
    )
  );

  // M5 — Unsubscribe each subscriber before disconnecting, so in-flight
  // messages are not lost during shutdown.
  const disconnectors = Array.from(subscriberConnections.entries()).map(
    async ([_jobId, tracked]) => {
      try {
        await tracked.redis.unsubscribe().catch(() => undefined);
      } catch {
        // Ignore unsubscribe errors — proceed to disconnect
      }
      tracked.redis.disconnect();
    }
  );
  await Promise.all(disconnectors);
  subscriberConnections.clear();

  // Now disconnect publisher and state store (no pending ops expected)
  // M19: getPublisher()/getStateStore() are lazy CONSTRUCTORS — calling them
  // in close instantiates fresh Redis clients just to disconnect them.
  if (_publisher) {
    try {
      _publisher.disconnect();
    } catch (err) {
      logger.warn({ err }, 'Error disconnecting publisher during close');
    }
    _publisher = null;
  }

  if (_stateStore) {
    try {
      _stateStore.disconnect();
    } catch (err) {
      logger.warn({ err }, 'Error disconnecting state store during close');
    }
    _stateStore = null;
  }
}
