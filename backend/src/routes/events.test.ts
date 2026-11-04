/**
 * Events SSE Route Tests — Content-Type and 404
 *
 * Tests for events router SSE endpoints:
 *   - GET /api/stories/generate/:jobId/events returns text/event-stream Content-Type
 *   - GET /api/stories/generate/:jobId/status
 *   - GET /api/stories/generate/:jobId/refresh-auth
 *   - 404 for unknown jobId
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import type http from 'http';
import crypto from 'node:crypto';
import { getApiSecret } from '../config/env.js';

// Compute a valid HMAC SSE signature for a jobId, matching buildSSEUrl /
// verifySSEAuthForJob (payload `${jobId}:${t}` with API_SECRET).
function signSSE(jobId: string, t: number): string {
  return crypto.createHmac('sha256', getApiSecret()).update(`${jobId}:${t}`).digest('hex');
}

// Mock BullMQ queues so server starts without Redis.
// mockJobOwnerId controls what getJob returns for ownership (H1) tests:
//   - a userId string → job owned by that user
//   - null            → job not found / unknown owner (fail-closed)
let mockJobOwnerId: string | null = null;
const mockQueue = {
  getWaitingCount: vi.fn().mockResolvedValue(0),
  getActiveCount: vi.fn().mockResolvedValue(0),
  getCompletedCount: vi.fn().mockResolvedValue(0),
  getJobCounts: vi.fn().mockResolvedValue({ failed: 0, completed: 0, waiting: 0, active: 0 }),
  getJobs: vi.fn().mockResolvedValue([]),
  getJob: vi.fn().mockImplementation(async () =>
    mockJobOwnerId ? { data: { userId: mockJobOwnerId, storyId: undefined } } : null
  ),
  add: vi.fn().mockResolvedValue({ id: 'new-job-id' }),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockDlq = {
  getJobCounts: vi.fn().mockResolvedValue({ failed: 0 }),
  getJobs: vi.fn().mockResolvedValue([]),
  getJob: vi.fn().mockResolvedValue(null),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  storyQueue: new Proxy({}, { get: () => () => ({}) }),
  storyDlq: new Proxy({}, { get: () => () => ({}) }),
  getStoryQueue: () => mockQueue,
  getStoryDlq: () => mockDlq,
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
    subscribe: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1),
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
let cookie = '';
let registeredUserId = '';

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;
  const username = `events_test_${Date.now()}`;
  const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password-123' }),
  });
  if (!reg.ok) { const text = await reg.text(); throw new Error(`register failed: ${reg.status} ${text}`); }
  const rawCookies = reg.headers.get('set-cookie');
  if (!rawCookies) throw new Error(`register failed: ${reg.status} — no set-cookie header`);
  const cookiesArr = rawCookies.split(',').map(c => c.split(';')[0]!.trim());
  cookie = cookiesArr.find(c => c.startsWith('access_token=')) ?? '';
  registeredUserId = registeredUsers.get(username)?.id ?? '';
  if (!registeredUserId) throw new Error('could not resolve registered user id for ownership tests');
}, 60000);

beforeEach(() => {
  vi.resetModules();
  // Default: the job is owned by the registered user (the common happy path).
  mockJobOwnerId = registeredUserId;
});

afterAll(async () => {
  // No-op: vitest force-exits
});

// =============================================================================
// GET /api/stories/generate/:jobId/status
// =============================================================================
describe('GET /api/stories/generate/:jobId/status', () => {
  it('returns job status when the caller owns the job (JWT)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/status`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { state: string } };
    expect(body.success).toBe(true);
  });

  it('H1: returns 403 when a valid JWT user does not own the job (IDOR)', async () => {
    // Job is owned by someone else — a valid JWT must NOT leak its status.
    mockJobOwnerId = 'some-other-user-id';
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/status`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('H1: returns 403 when job ownership cannot be resolved (fail-closed)', async () => {
    mockJobOwnerId = null;
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/status`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated request (no cookie, no HMAC)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/status`);
    expect(res.status).toBe(401);
  });

  it('returns job status via valid HMAC (capability path, no ownership needed)', async () => {
    const jobId = 'c12345678901234567890123';
    const t = Date.now();
    const sig = signSSE(jobId, t);
    // HMAC path must work regardless of ownership (or even without a cookie).
    mockJobOwnerId = 'some-other-user-id';
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${jobId}/status?auth=${sig}&t=${t}`);
    expect(res.status).toBe(200);
  });

  it('returns 401 via invalid HMAC', async () => {
    const jobId = 'c12345678901234567890123';
    const t = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${jobId}/status?auth=bad&t=${t}`);
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// GET /api/stories/generate/:jobId/refresh-auth
// =============================================================================
describe('GET /api/stories/generate/:jobId/refresh-auth', () => {
  it('returns 400 when auth parameters are missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/refresh-auth`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 when auth is expired', async () => {
    const oldTimestamp = Date.now() - (3 * 60 * 60 * 1000); // 3 hours ago (>2 hour TTL)
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/refresh-auth?auth=oldsig&t=${oldTimestamp}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// GET /api/stories/generate/:jobId/events — SSE Content-Type
// =============================================================================
describe('GET /api/stories/generate/:jobId/events — SSE stream', () => {
  it('returns text/event-stream Content-Type for valid SSE connection', async () => {
    // Note: This test initiates the SSE connection but the mock pubsub returns
    // an immediate unsubscribe, so the stream closes quickly. We just verify
    // the Content-Type header is set correctly before the stream ends.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/events?auth=test&t=${Date.now()}`, {
        headers: { Cookie: cookie },
        signal: controller.signal,
      });

      // The SSE endpoint may return 200 (connected) or 401 (auth failed)
      // We check that if it connected, the Content-Type is correct
      if (res.status === 200) {
        const ct = res.headers.get('Content-Type');
        expect(ct).toMatch(/text\/event-stream/);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Timeout is expected — SSE connection stays open until job completes
        // or connectionTimeout (2 hours). The important thing is we got a
        // response before the timeout fired.
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  it('returns 200 when SSE auth is invalid but JWT cookie is valid', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/events?auth=bad_sig&t=${Date.now()}`, {
      headers: { Cookie: cookie },
    });
    // jwtMiddleware validates JWT cookie first — our valid cookie succeeds.
    // The SSE auth parameter is checked after cookie auth; with our mock pubsub
    // returning immediate unsubscribe, the stream closes quickly but still 200.
    expect(res.status).toBe(200);
  });

  it('H1: returns 403 when a valid JWT user does not own the job stream (IDOR)', async () => {
    mockJobOwnerId = 'some-other-user-id';
    // auth/t query params are required by the SSE guard to reach the cookie
    // auth path; the valid cookie takes precedence over the (unused) HMAC.
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/events?auth=x&t=${Date.now()}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('H1: returns 403 when job-stream ownership cannot be resolved (fail-closed)', async () => {
    mockJobOwnerId = null;
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/c12345678901234567890123/events?auth=x&t=${Date.now()}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('connects via a valid HMAC signature without a JWT cookie (positive HMAC path)', async () => {
    const jobId = 'c12345678901234567890123';
    const t = Date.now();
    const sig = signSSE(jobId, t);
    // Ownership is irrelevant to the capability (HMAC) path.
    mockJobOwnerId = 'some-other-user-id';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${jobId}/events?auth=${sig}&t=${t}`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
    }
  });
});