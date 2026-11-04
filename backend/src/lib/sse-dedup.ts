/**
 * Distributed SSE connection deduplication.
 *
 * Problem: browsers auto-reconnect SSE streams. When a reconnect crosses
 * backend replicas, the local in-process Map used for dedup is invisible to
 * the new instance, so the same job can have multiple live SSE streams.
 *
 * Solution: keep a local Map of jobId -> close handler AND publish a Redis
 * control message on every new connection. Other instances subscribe to the
 * same channel and close their local connection for that jobId when they see
 * a reconnect. Redis failures are non-fatal — dedup degrades to per-instance
 * behavior, same as before.
 */

import crypto from 'node:crypto';
import { getSharedRedis } from './shared-redis.js';
import { logger } from '../services/logger.js';

const CONTROL_CHANNEL = 'sse:control:close';

const SSE_MAX_CONNECTIONS = 500;
const INSTANCE_ID = crypto.randomUUID();

export type SSECloseHandler = () => void;

const activeConnections = new Map<string, { close: SSECloseHandler; res: unknown }>();

let subscriberPromise: Promise<void> | null = null;

function getSubscriberRedis() {
  return getSharedRedis().duplicate();
}

// L20: hold a reference so a failed subscribe can be quit and a shutdown
// close can be registered — previously each failed attempt leaked a client.
let subscriberClient: ReturnType<typeof getSubscriberRedis> | null = null;

export async function closeSseDedupSubscriber(): Promise<void> {
  if (subscriberClient) {
    await subscriberClient.quit().catch(() => undefined);
    subscriberClient = null;
  }
}

async function ensureSubscribed(): Promise<void> {
  if (subscriberPromise) return subscriberPromise;
  subscriberPromise = (async () => {
    const sub = getSubscriberRedis();
    try {
      sub.on('message', (channel: string, message: string) => {
        if (channel !== CONTROL_CHANNEL) return;
        let parsed: { jobId?: string; instanceId?: string };
        try {
          parsed = JSON.parse(message) as { jobId?: string; instanceId?: string };
        } catch {
          return;
        }
        if (!parsed.jobId || parsed.instanceId === INSTANCE_ID) return;
        const existing = activeConnections.get(parsed.jobId);
        if (existing) {
          logger.info({ jobId: parsed.jobId }, 'SSE dedup: remote reconnect received, closing local connection');
          try { existing.close(); } catch { /* ignore */ }
        }
      });
      await sub.subscribe(CONTROL_CHANNEL);
      subscriberClient = sub;
    } catch (err) {
      // L20: quit the failed duplicate instead of leaking it.
      logger.warn({ err }, 'SSE dedup: failed to subscribe to control channel');
      await sub.quit().catch(() => undefined);
      subscriberPromise = null;
    }
  })();
  return subscriberPromise;
}

function evictOldestIfNeeded(): void {
  if (activeConnections.size >= SSE_MAX_CONNECTIONS) {
    const oldestKey = activeConnections.keys().next();
    if (!oldestKey.done && oldestKey.value !== undefined) {
      const oldest = activeConnections.get(oldestKey.value);
      if (oldest) {
        logger.warn({ evictedJobId: oldestKey.value, maxConnections: SSE_MAX_CONNECTIONS }, 'SSE connection evicted (max connections reached)');
        try { oldest.close(); } catch { /* ignore */ }
      }
      activeConnections.delete(oldestKey.value);
    }
  }
}

export async function registerSSEConnection(
  jobId: string,
  closeHandler: SSECloseHandler,
  res: unknown
): Promise<void> {
  await ensureSubscribed();

  const existing = activeConnections.get(jobId);
  if (existing) {
    logger.warn({ jobId }, 'SSE reconnect — closing previous connection (TOCTOU guard)');
    try { existing.close(); } catch { /* ignore */ }
  }

  evictOldestIfNeeded();
  activeConnections.set(jobId, { close: closeHandler, res });

  try {
    await getSharedRedis().publish(CONTROL_CHANNEL, JSON.stringify({ jobId, instanceId: INSTANCE_ID }));
  } catch (err) {
    logger.warn({ jobId, err }, 'SSE dedup: failed to publish close control message');
  }
}

export function unregisterSSEConnection(jobId: string): void {
  activeConnections.delete(jobId);
}

export function getActiveSSEConnectionCount(): number {
  return activeConnections.size;
}
