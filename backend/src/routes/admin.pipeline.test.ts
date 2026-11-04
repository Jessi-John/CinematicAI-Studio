/**
 * Integration tests for the /api/admin/settings/pipeline endpoints.
 *
 * These endpoints were added to close the gap discovered in E2E testing:
 * worker quality gates (grade_floor, quality_floor, etc.) were only writable
 * via direct SQL because the only admin setting endpoint was hard-coded to
 * timing keys.
 *
 * These tests pin the behavior of the new endpoints to prevent regressions:
 * - whitelist enforcement (unknown keys → 400)
 * - value validation (range, type, allowed grades)
 * - admin auth (no token → 401)
 * - CSRF (no token → 403)  [handled by global csrfMiddleware]
 * - persistence (validated value reaches the DB)
 *
 * These tests build a minimal Express app with only the admin router mounted,
 * rather than importing the full server.js which triggers OpenTelemetry
 * initialization and the entire module dependency graph. This keeps the
 * test lightweight and avoids environment-specific import hangs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type http from 'http';

// Mock BullMQ queues so admin router starts without Redis
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

vi.mock('../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'test-id', username: 'test', role: 'user' }),
  },
  systemSettings: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
      return { key: where.key, value: update?.value ?? create.value };
    }),
  },
  generationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    story: { delete: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    generationLog: { deleteMany: vi.fn().mockResolvedValue({}) },
  })),
};

(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

vi.mock('../middleware/jwt.js', () => ({
  verifyToken: vi.fn().mockReturnValue({ sub: 'test-user', username: 'test', role: 'admin' }),
  JWT_COOKIE: 'access_token',
  signToken: vi.fn().mockReturnValue('mock-jwt-token'),
  JWT_COOKIE_OPTIONS: {},
}));

// Set env vars the admin router needs
process.env.ADMIN_API_KEY = 'test-admin-key-pipeline-test';
process.env.API_SECRET = 'dev-secret-not-for-production';

describe('admin pipeline settings endpoint', () => {
  let port: number;
  let server: http.Server;
  let adminApiKey: string;

  beforeAll(async () => {
    adminApiKey = process.env.ADMIN_API_KEY!;
    const { adminRouter } = await import('../routes/admin.js');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', adminRouter);
    server = app.listen(0) as http.Server;
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server?.close();
  });

  const CSRF_COOKIE = `XSRF-TOKEN=${'a'.repeat(64)}`;

  const adminGet = (path: string, init: RequestInit = {}) =>
    fetch(`http://localhost:${port}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${adminApiKey}`,
        Cookie: CSRF_COOKIE,
        'X-CSRF-Token': 'a'.repeat(64),
      },
    });

  const adminPut = (path: string, body: unknown) =>
    adminGet(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('GET /api/admin/settings/pipeline', () => {
    it('requires admin auth (401 without bearer token)', async () => {
      const res = await fetch(`http://localhost:${port}/api/admin/settings/pipeline`, {
        headers: { 'X-CSRF-Token': 'a'.repeat(64), Cookie: CSRF_COOKIE },
      });
      expect(res.status).toBe(401);
    });

    it('returns the 5 pipeline settings when authenticated', async () => {
      mockPrismaClient.systemSettings.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
        const map: Record<string, string> = {
          quality_floor: '70',
          grade_floor: 'C',
          humanization_score_limit: '80',
          humanization_story_budget: '50',
          humanization_story_quality_retries: '2',
        };
        return map[where.key] ? { key: where.key, value: map[where.key] } : null;
      });
      const res = await adminGet('/api/admin/settings/pipeline');
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { qualityFloor: number; gradeFloor: string } };
      expect(body.data.qualityFloor).toBe(70);
      expect(body.data.gradeFloor).toBe('C');
    });
  });

  describe('PUT /api/admin/settings/pipeline/:key — whitelist', () => {
    it('rejects unknown key with 400', async () => {
      const res = await adminPut('/api/admin/settings/pipeline/some_unknown_key', { value: 70 });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/Unknown pipeline setting/);
    });

    it.each([
      ['quality_floor', 70],
      ['grade_floor', 'C'],
      ['humanization_score_limit', 80],
      ['humanization_story_budget', 50],
      ['humanization_story_quality_retries', 2],
    ] as const)('accepts whitelisted key %s with a value in range', async (key, value) => {
      const res = await adminPut(`/api/admin/settings/pipeline/${key}`, { value });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { key: string; value: string } };
      expect(body.data.key).toBe(key);
    });
  });

  describe('PUT /api/admin/settings/pipeline/:key — value validation', () => {
    it('quality_floor: 0 accepted, 100 accepted, 101 rejected, -1 rejected', async () => {
      expect((await adminPut('/api/admin/settings/pipeline/quality_floor', { value: 0 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/quality_floor', { value: 100 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/quality_floor', { value: 101 })).status).toBe(400);
      expect((await adminPut('/api/admin/settings/pipeline/quality_floor', { value: -1 })).status).toBe(400);
    });

    it('grade_floor: only A/B/C/D/F accepted, lowercase normalized to upper', async () => {
      for (const g of ['A', 'B', 'C', 'D', 'F']) {
        const res = await adminPut('/api/admin/settings/pipeline/grade_floor', { value: g });
        expect(res.status).toBe(200);
      }
      const res = await adminPut('/api/admin/settings/pipeline/grade_floor', { value: 'b' });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { value: string } };
      expect(body.data.value).toBe('B');
      const bad = await adminPut('/api/admin/settings/pipeline/grade_floor', { value: 'Z' });
      expect(bad.status).toBe(400);
    });

    it('grade_floor: empty string rejected', async () => {
      const res = await adminPut('/api/admin/settings/pipeline/grade_floor', { value: '' });
      expect(res.status).toBe(400);
    });

    it('humanization_score_limit: 0-100 range', async () => {
      expect((await adminPut('/api/admin/settings/pipeline/humanization_score_limit', { value: 0 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_score_limit', { value: 100 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_score_limit', { value: 101 })).status).toBe(400);
    });

    it('humanization_story_budget: 0-1000 range', async () => {
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_budget', { value: 0 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_budget', { value: 1000 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_budget', { value: 1001 })).status).toBe(400);
    });

    it('humanization_story_quality_retries: 0-10 range', async () => {
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_quality_retries', { value: 0 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_quality_retries', { value: 10 })).status).toBe(200);
      expect((await adminPut('/api/admin/settings/pipeline/humanization_story_quality_retries', { value: 11 })).status).toBe(400);
    });

    it('rejects missing value field', async () => {
      const res = await adminPut('/api/admin/settings/pipeline/quality_floor', {});
      expect(res.status).toBe(400);
    });

    it('rejects non-string non-number value', async () => {
      const res = await adminPut('/api/admin/settings/pipeline/quality_floor', { value: { nested: 'object' } });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/admin/settings/pipeline/:key — auth', () => {
    it('rejects without admin auth (401)', async () => {
      const res = await fetch(`http://localhost:${port}/api/admin/settings/pipeline/quality_floor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'a'.repeat(64), Cookie: CSRF_COOKIE },
        body: JSON.stringify({ value: 80 }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/admin/settings/pipeline/:key — persistence', () => {
    it('calls systemSettings.upsert with the validated value', async () => {
      mockPrismaClient.systemSettings.upsert.mockClear();
      const res = await adminPut('/api/admin/settings/pipeline/quality_floor', { value: 85 });
      expect(res.status).toBe(200);
      expect(mockPrismaClient.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'quality_floor' },
          update: { value: '85' },
          create: { key: 'quality_floor', value: '85' },
        })
      );
    });

    it('does not upsert when validation fails', async () => {
      mockPrismaClient.systemSettings.upsert.mockClear();
      const res = await adminPut('/api/admin/settings/pipeline/grade_floor', { value: 'Z' });
      expect(res.status).toBe(400);
      expect(mockPrismaClient.systemSettings.upsert).not.toHaveBeenCalled();
    });
  });
});
