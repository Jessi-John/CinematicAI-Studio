/**
 * Public Config Route Tests
 *
 * Tests for public-config router endpoint:
 *   - GET /api/public-config — returns genres, default genre, and max seed length
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';

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

vi.mock('../middleware/jwt.js', () => ({
  signToken: vi.fn().mockReturnValue('mock.jwt.token'),
  verifyToken: vi.fn().mockReturnValue({ sub: 'admin-id', username: 'admin', role: 'admin' }),
  JWT_COOKIE: 'access_token',
  JWT_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'strict' },
  getJwtSecret: vi.fn().mockReturnValue('dev-jwt-secret-not-for-production'),
  // REL-XXX: jwtMiddleware must be exported — server.ts imports it from jwt.ts
  jwtMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

process.env.KIMI_API_KEY = 'test-kimi-api-key';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';

vi.mock('../config/env.js', () => ({
  validateAndLoadEnv: vi.fn().mockReturnValue({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_PASSWORD: '',
    API_SECRET: 'dev-secret-not-for-production',
    ADMIN_API_KEY: 'test_admin_key',
    JWT_SECRET: 'dev-jwt-secret-not-for-production',
    MISTRAL_API_KEY: 'test-mistral-api-key',
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_MODEL: 'mistral-medium-2508',
    KIMI_API_KEY: 'test-kimi-api-key',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1/chat/completions',
    KIMI_MODEL: 'k3',
  }),
  getApiSecret: vi.fn().mockReturnValue('dev-secret-not-for-production'),
  getAdminApiKey: vi.fn().mockReturnValue('test_admin_key'),
  getJwtSecret: vi.fn().mockReturnValue('dev-jwt-secret-not-for-production'),
  getRedisPassword: vi.fn().mockReturnValue(''),
  getPort: vi.fn().mockReturnValue(0),
  getRequestTimeoutMs: vi.fn().mockReturnValue(300000),
  getShutdownDrainMs: vi.fn().mockReturnValue(30000),
  getRunWorkerInprocess: vi.fn().mockReturnValue(false),
  getWorkerHealthPort: vi.fn().mockReturnValue(3001),
  getWorkerHealthBind: vi.fn().mockReturnValue('0.0.0.0'),
  getMonthlyTokenBudget: vi.fn().mockReturnValue(0),
  getDailyTokenBudget: vi.fn().mockReturnValue(0),
  allowInsecureLocalHttp: vi.fn().mockReturnValue(false),
  isRegistrationDisabled: vi.fn().mockReturnValue(false),
  getInviteCode: vi.fn().mockReturnValue(undefined),
  getMaxConcurrentGenerations: vi.fn().mockReturnValue(0),
  getMaxStoriesPerDay: vi.fn().mockReturnValue(0),
  getDailySpendCapUsd: vi.fn().mockReturnValue(0),
  getMonthlySpendCapUsd: vi.fn().mockReturnValue(0),
  getBackupS3Bucket: vi.fn().mockReturnValue(undefined),
  getBackupS3Prefix: vi.fn().mockReturnValue('cinematicai-backups'),
  getAlertWebhookUrl: vi.fn().mockReturnValue(undefined),
}));

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
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'test-id', username: 'test', role: 'user' }),
  },
  systemSettings: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({}),
  },
  generationLog: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    story: { delete: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    generationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  })),
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
}, 60000);

afterAll(async () => {
  // No-op: vitest force-exits
});

// =============================================================================
// GET /api/public-config — no auth required
// =============================================================================
describe('GET /api/public-config', () => {
  it('returns 200 without authentication', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    expect(res.status).toBe(200);
  });

  it('returns success envelope with data object', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    const body = await res.json() as { success?: boolean; data?: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(typeof body.data).toBe('object');
  });

  it('returns GENRES array inside data object', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    const body = await res.json() as { data?: { GENRES?: string[] } };
    expect(Array.isArray(body.data?.GENRES)).toBe(true);
    expect(body.data?.GENRES?.length).toBeGreaterThan(0);
  });

  it('does NOT expose NODE_ENV (L5 security fix)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    const body = await res.json() as { data?: { mode?: string } };
    // The /public-config endpoint must not include the mode field at
    // all (not even as undefined). Including the field would hint at
    // the server's environment to a probing client.
    expect(body.data).not.toHaveProperty('mode');
  });

  it('returns valid JSON (no HTML error page)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    const ct = res.headers.get('Content-Type');
    expect(ct).toMatch(/application\/json/);
  });
});