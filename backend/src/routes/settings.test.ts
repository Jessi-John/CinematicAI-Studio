/**
 * Settings Route Tests — 404/type validation/batch operations
 *
 * Tests for settings router endpoints:
 *   - GET /api/settings/:key returns 404 for missing key
 *   - PATCH /api/settings/:key type validation (settings.ts registers PATCH,
 *     not PUT — see the route definitions for the source of truth)
 *   - PATCH /api/settings (batch operations)
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

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => ({
    on: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue([1, 0, 0, 'ok']),
    call: vi.fn().mockImplementation(async (command: string) => {
      if (command === 'SCRIPT') return 'mock-script-sha';
      if (command === 'EVALSHA') return [1, 60000];
      return 'OK';
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    status: 'ready',
    duplicate: vi.fn().mockReturnThis(),
    quit: vi.fn().mockResolvedValue('OK'),
  }),
  closeSharedRedis: vi.fn().mockResolvedValue(undefined),
}));

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

const mockSettings = new Map<string, { key: string; value: string; type: string }>([
  ['existing_key', { key: 'existing_key', value: 'test_value', type: 'string' }],
]);

const mockSystemSettings = new Map<string, { key: string; value: string; type: string }>();

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ reltuples: BigInt(1) }]),
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
      // Mirror auth.ts bootstrap: first registered user becomes admin so the
      // test session can exercise admin-protected mutation endpoints.
      const role = registeredUsers.size === 0 ? 'admin' : 'user';
      const user = { id: `user-${Date.now()}`, username: data.username, role, passwordHash: data.passwordHash };
      registeredUsers.set(data.username, user);
      return user;
    }),
    findFirst: vi.fn().mockImplementation(async () => registeredUsers.values().next().value ?? null),
  },
  systemSettings: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => {
      return mockSystemSettings.get(where.key) ?? null;
    }),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key: string }; update: { value: string; type: string }; create: { key: string; value: string; type: string } }) => {
      const existing = mockSystemSettings.get(where.key);
      const next = existing ?? { ...create };
      next.value = update.value;
      next.type = update.type;
      mockSystemSettings.set(where.key, next);
      return next;
    }),
  },
  userSettings: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key?: string; userId_key?: { userId: string; key: string } } }) => {
      const key = where.key ?? where.userId_key?.key;
      return key ? mockSettings.get(key) ?? null : null;
    }),
    findMany: vi.fn().mockResolvedValue(Array.from(mockSettings.values())),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key?: string; userId_key?: { userId: string; key: string } }; update: { value: string; type: string }; create: { key: string; value: string; type: string } }) => {
      const key = where.key ?? where.userId_key?.key;
      if (!key) throw new Error('Missing key in userSettings.upsert');
      const existing = mockSettings.get(key);
      const next = existing ?? { ...create };
      next.value = update.value;
      next.type = update.type;
      mockSettings.set(key, next);
      return next;
    }),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { key?: string; userId_key?: { userId: string; key: string } } }) => {
      const key = where.key ?? where.userId_key?.key;
      if (!key) throw new Error('Missing key in userSettings.delete');
      const existing = mockSettings.get(key);
      if (!existing) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      mockSettings.delete(key);
      return existing;
    }),
  },
  generationLog: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrismaClient)),
};

(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

let port: number;
let server: http.Server;
let cookie = '';
let userCookie = '';

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;

  async function loginCookie(username: string): Promise<string> {
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
    return `${accessToken}; XSRF-TOKEN=${'a'.repeat(64)}`;
  }

  // First registered user becomes admin (mirrors auth.ts bootstrap).
  cookie = await loginCookie(`settings_test_${Date.now()}`);
  // Second user remains a regular user for negative authorization tests.
  userCookie = await loginCookie(`settings_user_${Date.now()}`);
}, 60000);

afterAll(async () => {
  // No-op: vitest force-exits
});

function csrfHeaders(forCookie: string = cookie): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: forCookie,
    'X-CSRF-Token': 'a'.repeat(64),
  };
}

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: cookie,
    Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  };
}

// =============================================================================
// GET /api/settings/:key — 404 for missing key
// =============================================================================
describe('GET /api/settings/:key — 404 for missing key', () => {
  it('returns 404 for non-existent setting key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/nonexistent_key_xyz`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it('returns400 for invalid key format', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/key with spaces`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for key that is too long', async () => {
    const longKey = 'a'.repeat(101);
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/${longKey}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 for existing key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/existing_key`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { key: string } };
    expect(body.success).toBe(true);
    expect(body.data.key).toBe('existing_key');
  });
});

// =============================================================================
// PATCH /api/settings/:key — type validation
// (settings.ts registers PATCH, not PUT; the test sends PATCH so the
// describe label here is the human-readable contract, not the HTTP verb.)
// =============================================================================
describe('PATCH /api/settings/:key — type validation', () => {
  it('accepts string value with string type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key_str`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'hello', type: 'string' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts number value with number type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key_num`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 42, type: 'number' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts boolean value with boolean type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key_bool`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: true, type: 'boolean' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts object value with json type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key_json`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: { nested: 'object' }, type: 'json' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects missing value field', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid type value', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test', type: 'invalid_type' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing type field (defaults to string)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test' }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid key format', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/key with spaces`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts mutation via admin API key without CSRF', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/api_key_test_key`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(200);
  });

  it('requires admin authorization (403 for regular user)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key`, {
      method: 'PATCH',
      headers: csrfHeaders(userCookie),
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(403);
  });

  it('requires CSRF token for cookie auth (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_key`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// PATCH /api/settings — batch operations
// (settings.ts registers PATCH, not PUT; the test sends PATCH.)
// =============================================================================
describe('PATCH /api/settings — batch operations', () => {
  it('accepts batch array of settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({
        settings: [
          { key: 'batch_key_1', value: 'value1', type: 'string' },
          { key: 'batch_key_2', value: 100, type: 'number' },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects non-array settings body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ settings: 'not an array' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts empty array as no-op', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ settings: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('skips invalid entries in batch but processes valid ones', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({
        settings: [
          { key: 'valid_key', value: 'valid', type: 'string' },
          { key: 'invalid key', value: 'bad', type: 'string' }, // invalid key format
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { applied: { key: string }[]; rejected: { key: string }[] } };
    expect(body.success).toBe(true);
    expect(body.data.applied.length).toBe(1);
    expect(body.data.rejected.length).toBe(1);
    expect(body.data.applied[0]!.key).toBe('valid_key');
    expect(body.data.rejected[0]!.key).toBe('invalid key');
  });

  it('requires admin authorization (403 for regular user)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: csrfHeaders(userCookie),
      body: JSON.stringify({ settings: [{ key: 'k', value: 'v', type: 'string' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('requires CSRF token for cookie auth (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: [{ key: 'k', value: 'v', type: 'string' }] }),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// DELETE /api/settings/:key
// =============================================================================
describe('DELETE /api/settings/:key', () => {
  it('deletes an existing setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/existing_key`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('returns 400 for invalid key format', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/key with spaces`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(400);
  });

  it('accepts delete via admin API key without CSRF', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/existing_key`, {
      method: 'DELETE',
      headers: { Cookie: cookie, Authorization: `Bearer ${process.env.ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it('requires admin authorization (403 for regular user)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/existing_key`, {
      method: 'DELETE',
      headers: { Cookie: userCookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(403);
  });

  it('requires CSRF token for cookie auth (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/existing_key`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('M1: refuses to delete a pipeline quality-gate key (400)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/quality_floor`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('pipeline quality gate');
  });
});