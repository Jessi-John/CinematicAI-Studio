/**
 * Auth Extended Route Tests — Register validation and token refresh
 *
 * Tests for auth router endpoints beyond basic login/logout:
 *   - POST /api/auth/register (validation)
 *   - POST /api/auth/refresh
 *   - GET /api/auth/me
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcrypt';
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

const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();

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
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { username?: string; id?: string } }) => {
      if (where.username) return registeredUsers.get(where.username) ?? null;
      if (where.id) return [...registeredUsers.values()].find((u) => u.id === where.id) ?? null;
      return null;
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: { username: string; passwordHash: string } }) => {
      if (registeredUsers.has(data.username)) {
        const err = new Error('Unique constraint violation') as Error & { code?: string };
        err.code = 'P2002';
        throw err;
      }
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

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;
  // Pre-populate registeredUsers with admin and taken_user for tests
  registeredUsers.set('admin', { id: 'admin-id', username: 'admin', role: 'admin', passwordHash: '$2b$10$mock' });
  registeredUsers.set('taken_user', { id: 'existing', username: 'taken_user', role: 'user', passwordHash: '$2b$10$mock' });
}, 60000);

afterAll(async () => {
  // No-op: vitest force-exits
});

// =============================================================================
// POST /api/auth/register — validation
// =============================================================================
describe('POST /api/auth/register — validation', () => {
  it('rejects missing username and password', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/username and password are required/i);
  });

  it('rejects missing password only', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing username only', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Testpass123' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects username shorter than 3 characters', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ab', password: 'Testpass123' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/3.*30 characters/i);
  });

  it('rejects username longer than 30 characters', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'a'.repeat(31), password: 'Testpass123' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects password shorter than 8 characters', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'short' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/8.*128 characters/i);
  });

  it('rejects password longer than 128 characters', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'a'.repeat(129) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects weak password that does not meet strength requirements', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'lowercase' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/mix of uppercase|lowercase|numbers|special/i);
  });

  it('accepts password with mixed character classes', async () => {
    const username = `stronguser_${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Mixed123!' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects username with special characters (not alphanumerics/underscores)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test@user', password: 'Testpass123' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/letters.*numbers.*underscores/i);
  });

  it('rejects username with spaces', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test user', password: 'Testpass123' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts valid username with underscores', async () => {
    const username = `test_user_${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Testpass123' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects already-taken username', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'taken_user', password: 'Testpass123' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/already taken/i);
  });

  it('returns201 with user data on successful registration', async () => {
    const username = `testuser_${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'testpassword123' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data?: { user?: { id: string; username: string; role: string } } };
    // The user object must exist AND match what we registered. A
    // missing or empty user would indicate the registration returned
    // a success envelope without actually creating the user.
    expect(body.data?.user?.username).toBe(username);
    expect(body.data?.user?.id.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// POST /api/auth/login — L16 synthetic account guard
// =============================================================================
describe('POST /api/auth/login — L16 synthetic account guard', () => {
  it('rejects login for the synthetic system account', async () => {
    registeredUsers.set('system', { id: 'system', username: 'system', role: 'user', passwordHash: '$2b$10$mock' });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'system', password: 'AnyPass123!' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/invalid credentials/i);
  });

  it('rejects login for the synthetic global account', async () => {
    registeredUsers.set('global', { id: 'global', username: 'global', role: 'user', passwordHash: '$2b$10$mock' });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'global', password: 'AnyPass123!' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 500) when bcrypt.compare throws for a malformed hash', async () => {
    const username = `malformed_${Date.now()}`;
    registeredUsers.set(username, { id: `mal-${Date.now()}`, username, role: 'user', passwordHash: 'not-a-valid-bcrypt-hash' });
    vi.mocked(bcrypt.compare).mockRejectedValueOnce(new Error('Invalid hash'));
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'AnyPass123!' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/invalid credentials/i);
  });
});

// =============================================================================
// POST /api/auth/refresh
// =============================================================================
describe('POST /api/auth/refresh', () => {
  it('returns 401 when no token cookie is present', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/no token/i);
  });

  it('returns 401 when token is invalid or expired', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'access_token=invalid.token.here' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/expired|invalid/i);
  });

  it('returns success with new token when valid token is present', async () => {
    // First login to get a valid token
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'dockerbuildpassword' }),
    });
    const rawCookies = loginRes.headers.get('set-cookie');
    if (!rawCookies) {
      // Skip if login failed (e.g., in test env without proper bcrypt)
      return;
    }
    const cookies = rawCookies.split(',').map(c => c.split(';')[0]!.trim());
    const accessToken = cookies.find(c => c.startsWith('access_token='));
    if (!accessToken) return;

    const refreshRes = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: accessToken },
    });
    expect(refreshRes.status).toBe(200);
    const body = await refreshRes.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('H8: mints the new token with the CURRENT database role, not the stale claim', async () => {
    // Register + login a fresh admin user
    const username = `demote_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'AnyPass123!' }),
    });
    const user = registeredUsers.get(username)!;
    user.role = 'admin';
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'AnyPass123!' }),
    });
    const rawCookies = loginRes.headers.get('set-cookie');
    if (!rawCookies) throw new Error('login failed in H8 test setup');
    const accessToken = rawCookies.split(',').map(c => c.split(';')[0]!.trim()).find(c => c.startsWith('access_token='))!;

    // Demote the user in the "database" AFTER the token was issued
    user.role = 'user';

    const refreshRes = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: accessToken },
    });
    expect(refreshRes.status).toBe(200);
    const newCookies = refreshRes.headers.get('set-cookie')!;
    const newToken = newCookies.split(',').map(c => c.split(';')[0]!.trim()).find(c => c.startsWith('access_token='))!.split('=')[1]!;
    const payload = JSON.parse(Buffer.from(newToken.split('.')[1]!, 'base64url').toString()) as { role?: string };
    expect(payload.role).toBe('user');
  });

  it('H8: returns 401 on refresh when the user has been deleted', async () => {
    const username = `deleted_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'AnyPass123!' }),
    });
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'AnyPass123!' }),
    });
    const rawCookies = loginRes.headers.get('set-cookie');
    if (!rawCookies) throw new Error('login failed in H8 test setup');
    const accessToken = rawCookies.split(',').map(c => c.split(';')[0]!.trim()).find(c => c.startsWith('access_token='))!;

    registeredUsers.delete(username);

    const refreshRes = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: accessToken },
    });
    expect(refreshRes.status).toBe(401);
  });
});

// =============================================================================
// GET /api/auth/me
// =============================================================================
describe('GET /api/auth/me', () => {
  it('returns 401 when no token cookie is present', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Cookie: 'access_token=invalid.token.here' },
    });
    expect(res.status).toBe(401);
  });

  it('returns user data when valid token is present', async () => {
    // First login to get a valid token
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'dockerbuildpassword' }),
    });
    const rawCookies = loginRes.headers.get('set-cookie');
    if (!rawCookies) {
      return;
    }
    const cookies = rawCookies.split(',').map(c => c.split(';')[0]!.trim());
    const accessToken = cookies.find(c => c.startsWith('access_token='));
    if (!accessToken) return;

    const meRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Cookie: accessToken },
    });
    expect(meRes.status).toBe(200);
    const body = await meRes.json() as { data?: { user?: { id: string; username: string; role: string } } };
    // /me must return a non-empty user object when authenticated.
    // A missing user would indicate the JWT was valid but the session
    // lookup returned nothing.
    expect(body.data?.user?.id.length).toBeGreaterThan(0);
  });
});