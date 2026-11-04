/**
 * User Settings Route Tests — GET/PUT/DELETE
 *
 * Tests for user-settings router endpoints:
 *   - GET /api/user-settings (list all)
 *   - GET /api/user-settings/:key (single)
 *   - PUT /api/user-settings/:key (upsert single)
 *   - PUT /api/user-settings (batch)
 *   - DELETE /api/user-settings/:key
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';

// Mock BullMQ queues so server starts without Redis
vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  storyQueue: new Proxy({}, { get: () => () => ({}) }),
  storyDlq: new Proxy({}, { get: () => () => ({}) }),
  getStoryQueue: () => ({ add: async () => ({}), getJob: async () => null, close: async () => {} }),
  getStoryDlq: () => ({ add: async () => ({}), close: async () => {} }),
  addStoryJob: async () => ({}),
  getJobStatus: async () => ({ state: 'unknown', progress: 0 }),
  closeQueues: async () => {},
  closeDlq: async () => {},
}));

vi.mock('../lib/shared-redis.js', () => {
  // Script cache to simulate proper script loading (required by rate-limit-redis v4)
  const scriptCache = new Map<string, string>();
  return {
    getSharedRedis: () => ({
      on: vi.fn(),
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      setex: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
      eval: vi.fn().mockResolvedValue([1, 0, 0, 'ok']),
      call: vi.fn().mockImplementation(async (command: string, ...args: string[]) => {
        // Handle SCRIPT LOAD - cache script and return SHA
        if (command === 'SCRIPT' && args[0] === 'LOAD') {
          const sha = 'mock_sha_' + Math.random().toString(36).slice(2);
          scriptCache.set(sha, args[1] as string);
          return sha;
        }
        // Handle EVALSHA - use cached script
        if (command === 'EVALSHA') {
          const script = scriptCache.get(args[0] as string);
          if (script) return [1, 60000];
          return [1, 60000]; // fallback
        }
        return 'OK';
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      status: 'ready',
      duplicate: vi.fn().mockReturnThis(),
      quit: vi.fn().mockResolvedValue('OK'),
    }),
    closeSharedRedis: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../queue/redis-pubsub.js', () => ({
  CHANNELS: { progress: (jobId: string) => `job:${jobId}:progress` },
  publishProgress: vi.fn().mockResolvedValue(undefined),
  setJobState: vi.fn().mockResolvedValue(undefined),
  getJobState: vi.fn().mockResolvedValue(null),
  markJobFailed: vi.fn().mockResolvedValue(undefined),
  deleteJobCandidate: vi.fn().mockResolvedValue(undefined),
  subscribeToJobEvents: vi.fn().mockResolvedValue({ unsubscribe: () => {} }),
  closePubSub: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../queue/workers/worker-factory.js', () => ({
  createStoryWorker: vi.fn().mockReturnValue({ worker: {}, closeDlq: async () => {} }),
}));

vi.mock('../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

process.env.KIMI_API_KEY = 'test-kimi-api-key';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock bcrypt so login can succeed with any password
vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue('$2b$10$mock'),
  },
}));

// Mock rate-limit module to bypass Redis dependency
vi.mock('../middleware/rate-limit.js', () => ({
  generalLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  aiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  storiesLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  exportLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  healthLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobsLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  perUserLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));


const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();

const mockUserSettings = new Map<string, { key: string; value: string; type: string; updatedAt: Date }>([
  ['theme', { key: 'theme', value: 'dark', type: 'string', updatedAt: new Date() }],
  ['quality_floor', { key: 'quality_floor', value: '70', type: 'string', updatedAt: new Date() }],
]);

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ reltuples: BigInt(2) }]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(0),
  },
  user: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { username: string } }) => {
      return registeredUsers.get(where.username) ?? null;
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: { username: string; passwordHash: string } }) => {
      const user = { id: `user-${Date.now()}`, username: data.username, role: 'user', passwordHash: data.passwordHash };
      registeredUsers.set(data.username, user);
      return user;
    }),
    findFirst: vi.fn().mockImplementation(async () => registeredUsers.values().next().value ?? null),
  },
  systemSettings: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({}),
  },
  userSettings: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key?: string; userId_key?: { userId: string; key: string } } }) => {
      const key = where.key ?? where.userId_key?.key;
      return key ? mockUserSettings.get(key) ?? null : null;
    }),
    findMany: vi.fn().mockResolvedValue(Array.from(mockUserSettings.values())),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key?: string; userId_key?: { userId: string; key: string } }; update: { value: string; type: string }; create: { key: string; value: string; type: string } }) => {
      const key = where.key ?? where.userId_key?.key ?? create.key;
      if (!key) throw new Error('Missing key in userSettings.upsert');
      const existing = mockUserSettings.get(key);
      const next = existing ?? { ...create, updatedAt: new Date() };
      next.value = update.value;
      next.type = update.type;
      mockUserSettings.set(key, next);
      return next;
    }),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { key?: string; userId_key?: { userId: string; key: string } } }) => {
      const key = where.key ?? where.userId_key?.key;
      if (!key) throw new Error('Missing key in userSettings.delete');
      const existing = mockUserSettings.get(key);
      if (!existing) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      mockUserSettings.delete(key);
      return existing;
    }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  generationLog: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (arg: unknown[] | ((tx: unknown) => unknown)) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return arg(mockPrismaClient);
  }),
};

(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));



let port: number;
let server: http.Server;
let cookie = '';

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;
  const username = `us_${Date.now()}`;
  const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password-123' }),
  });
  if (!reg.ok) { const text = await reg.text(); throw new Error(`register failed: ${reg.status} ${text}`); }
  const rawCookies = reg.headers.get('set-cookie');
  if (!rawCookies) throw new Error(`register succeeded but no set-cookie: ${reg.status}`);
  const cookieArr = rawCookies.split(',').map(c => c.split(';')[0]!.trim());
  const accessToken = cookieArr.find(c => c.startsWith('access_token='))!;
  cookie = `${accessToken}; XSRF-TOKEN=${'a'.repeat(64)}`;
}, 60000);

afterAll(async () => {
  // No-op: vitest force-exits
});

function csrfHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRF-Token': 'a'.repeat(64),
  };
}

// =============================================================================
// GET /api/user-settings
// =============================================================================
describe('GET /api/user-settings', () => {
  it('returns all user settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('requires auth (401 without cookie)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// GET /api/user-settings/:key
// =============================================================================
describe('GET /api/user-settings/:key', () => {
  it('returns single user setting for known key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/theme`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { key: string } };
    expect(body.success).toBe(true);
    expect(body.data.key).toBe('theme');
  });

  it('returns 404 for unknown key with empty value', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/nonexistent_key_xyz`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid key format', async () => {
    const longKey = 'a'.repeat(101); // exceeds max(100) in keyParamSchema
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/${longKey}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for key that is too long', async () => {
    const longKey = 'a'.repeat(101);
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/${longKey}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// PUT /api/user-settings/:key
// =============================================================================
describe('PUT /api/user-settings/:key', () => {
  it('upserts a string setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test_value', type: 'string' }),
    });
    expect(res.status).toBe(200);
  });

  it('upserts a number setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_num_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: '42', type: 'number' }),
    });
    expect(res.status).toBe(200);
  });

  it('upserts a boolean setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_bool_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'true', type: 'boolean' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid request body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ invalid: 'body' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing value field', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ type: 'string' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test', type: 'invalid_type' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid key format', async () => {
    const longKey = 'a'.repeat(101); // exceeds max(100) in keyParamSchema
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/${longKey}`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires CSRF token (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_key`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// PUT /api/user-settings — batch
// =============================================================================
describe('PUT /api/user-settings — batch', () => {
  it('accepts batch array of settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({
        settings: [
          { key: 'batch_key_1', value: 'value1', type: 'string' },
          { key: 'batch_key_2', value: 'value2', type: 'string' },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects non-array settings body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ settings: 'not an array' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid entries in batch', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({
        settings: [
          { key: 'valid_key', value: 'valid', type: 'string' },
          { key: '', value: 'bad', type: 'string' }, // empty key
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('requires CSRF token (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: [{ key: 'k', value: 'v', type: 'string' }] }),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// DELETE /api/user-settings/:key
// =============================================================================
describe('DELETE /api/user-settings/:key', () => {
  it('deletes an existing user setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/theme`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid key format', async () => {
    const longKey = 'a'.repeat(101); // exceeds max(100) in keyParamSchema
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/${longKey}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(400);
  });

  it('requires CSRF token (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/theme`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });
});