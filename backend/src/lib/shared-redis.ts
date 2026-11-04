/**
 * Shared Redis client singleton.
 *
 * All components that need Redis should import from here instead of
 * creating their own ioredis clients. This prevents connection slot
 * exhaustion when many clients each maintain their own pool.
 *
 * Uses the shared createRedis factory for consistent DNS resolution
 * behavior (bypasses Docker DNS cache for horizontal scaling support).
 */

import { Redis } from 'ioredis';
import { getRedisUrl } from '../queue/index.js';
import { getRedisPassword } from '../config/env.js';
import { createRedis } from './create-redis.js';

import pino from 'pino';
const _redisErrorLogger = pino({ level: 'warn', name: 'redis-shared' });

let _client: Redis | null = null;

export function getSharedRedis(): Redis {
  if (!_client) {
    _client = createRedis(getRedisUrl(), {
      password: getRedisPassword(),
      maxRetriesPerRequest: 3,
    });
    _client.on('error', (err: Error) => {
      // Log at warn level — shared client may be used by components that have
      // their own fallback behaviour (e.g. rate-limiters fall back to memory).
      // Use a dedicated pino instance to avoid circular imports with the
      // project logger. If pino itself fails, fall back to console.warn.
      try {
        _redisErrorLogger.warn({ err }, 'Shared Redis client error');
      } catch {
        try { console.warn('Shared Redis client error:', err?.message ?? err); } catch { /* last resort */ }
      }
    });
  }
  return _client;
}

export async function closeSharedRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}