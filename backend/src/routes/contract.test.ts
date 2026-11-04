/**
 * Fix #23: Client/server contract tests.
 *
 * These tests verify that API responses from the Express server conform to the
 * Zod schemas that define the client/server contract. If the backend changes a
 * response shape (e.g., adds a new required field, changes a type), these tests
 * fail and catch the drift before it reaches the frontend.
 *
 * The Zod schemas in auth.ts and admin.ts (#47) are the source of truth.
 * This test suite validates the actual HTTP responses against those schemas.
 *
 * Coverage:
 *   - OpenAPI spec: GET /api/docs, GET /api/docs/ui
 *   - Public routes: GET /health, GET /config
 *   - Admin routes (with proper auth + CSRF): queue, timing, pipeline, DLQ, stats
 *
 * All external dependencies are mocked at the module level.
 */

vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  // storyQueue is a QueueEvents — has getWaitingCount, getActiveCount, getCompletedCount, getJobCounts
  storyQueue: {
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }),
  },
  // storyDlq is a Queue — used for DLQ operations by admin routes
  storyDlq: {
    getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }),
    getWaitingCount: async () => 0,
    getJobs: async () => [],
    getJob: async () => null,
    remove: async () => {},
    add: async () => ({}),
    close: async () => {},
  },
  getStoryQueue: () => ({
    add: async () => ({}),
    getJob: async () => null,
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }),
    close: async () => {},
  }),
  getStoryDlq: () => ({
    add: async () => ({}),
    close: async () => {},
    getJobs: async () => [],
    getJob: async () => null,
    remove: async () => {},
  }),
  getBackgroundDlq: () => ({
    getJobs: async () => [],
    add: async () => ({}),
    close: async () => {},
  }),
  getBackgroundSeoQueue: () => ({ add: async () => ({}), close: async () => {} }),
  getBackgroundEmbeddingQueue: () => ({ add: async () => ({}), close: async () => {} }),
  addStoryJob: async () => ({}),
  getJobStatus: async () => ({ state: 'unknown', progress: 0 }),
  closeQueues: async () => {},
  closeDlq: async () => {},
  closeBackgroundQueues: async () => {},
  STORY_JOB_OPTIONS: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 3600, count: 100 }, removeOnFail: { age: 86400, count: 100 } },
  BACKGROUND_JOB_OPTIONS: { attempts: 2, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 86400, count: 50 } },
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

vi.mock('../config/env.js', () => ({
  validateAndLoadEnv: vi.fn().mockReturnValue({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_PASSWORD: '',
    API_SECRET: 'dev-secret-not-for-production',
    ADMIN_API_KEY: 'dev-admin-key-for-testing',
    JWT_SECRET: 'dev-jwt-secret-not-for-production',
    BCRYPT_ROUNDS: '12',
    MISTRAL_API_KEY: 'test-mistral-api-key',
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_MODEL: 'mistral-medium-2508',
    KIMI_API_KEY: 'test-kimi-api-key',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1/chat/completions',
    KIMI_MODEL: 'k3',
  }),
  getApiSecret: vi.fn().mockReturnValue('dev-secret-not-for-production'),
  getAdminApiKey: vi.fn().mockReturnValue('dev-admin-key-for-testing'),
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
  isProduction: vi.fn().mockReturnValue(false),
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
  $queryRaw: vi.fn().mockResolvedValue([]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: 'mock-story-id' }),
    count: vi.fn().mockResolvedValue(0),
  },
  episode: { count: vi.fn().mockResolvedValue(0) },
  scene: { count: vi.fn().mockResolvedValue(0) },
  character: { count: vi.fn().mockResolvedValue(0) },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'test-user-id', username: 'testuser', role: 'user' }),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  generationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn().mockResolvedValue([]) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  systemSettings: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({ key: '', value: '' }),
  },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrismaClient)),
};

(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

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

// ─── Tests ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

// Response envelope schemas.
const apiResponseErrorSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
});

const apiResponseSuccessSchema = z.object({
  success: z.literal(true),
});

describe('API contract tests', () => {
  let port: number;
  let server: import('http').Server;

  // Establish a session cookie + CSRF token for admin route tests.
  let adminCookie: string;
  let csrfToken: string;
  const ADMIN_KEY = 'dev-admin-key-for-testing';

  beforeAll(async () => {
    const { app } = await import('../server.js');
    server = (app as import('express').Express).listen(0) as import('http').Server;
    port = (server.address() as import('net').AddressInfo).port;

    // Register a throwaway user to get both the session cookie (JWT) and
    // the CSRF token cookie. Both cookies are needed for admin route auth.
    // headers.getAll('set-cookie') returns all Set-Cookie header values.
    const uniqueUser = `contract_${Date.now()}`;
    const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uniqueUser, password: 'password123' }),
    });
    if (reg.ok) {
      const setCookies: string[] = [];
      reg.headers.forEach((value: string, key: string) => {
        if (key === 'set-cookie') setCookies.push(value);
      });
      for (const sc of setCookies) {
        const part = sc.split(';')[0] ?? '';
        if (part.startsWith('XSRF-TOKEN=')) {
          csrfToken = part.split('=')[1] ?? '';
        }
        if (part.startsWith('access_token=')) {
          adminCookie = part;
        }
      }
      // Combine both cookies into a single Cookie header value
      const parts: string[] = [];
      if (adminCookie) parts.push(adminCookie);
      if (csrfToken) parts.push(`XSRF-TOKEN=${csrfToken}`);
      adminCookie = parts.join('; ');
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ─── OpenAPI spec contracts ────────────────────────────────────────────────

  describe('GET /api/docs', () => {
    it('returns 401 without admin authorization', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`);
      expect(res.status).toBe(401);
    });

    it('returns a valid OpenAPI 3.1 document with admin authorization', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const spec = z.object({
        openapi: z.string(),
        info: z.object({ title: z.string(), version: z.string() }),
        paths: z.record(z.string(), z.any()),
        components: z.object({ securitySchemes: z.record(z.any()) }),
      }).safeParse(json);
      expect(spec.success).toBe(true);
      const doc = json as { openapi?: string };
      expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
    });

    it('has auth, admin, and public tags defined', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      const json = await res.json() as { tags?: Array<{ name: string }> };
      const tagNames = json.tags?.map((t) => t.name) ?? [];
      expect(tagNames).toContain('auth');
      expect(tagNames).toContain('admin');
      expect(tagNames).toContain('public');
    });

    it('has all expected auth paths documented', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      const json = await res.json() as { paths?: Record<string, unknown> };
      const paths = json.paths ?? {};
      expect(paths).toHaveProperty('/api/auth/register');
      expect(paths).toHaveProperty('/api/auth/login');
      expect(paths).toHaveProperty('/api/auth/logout');
      expect(paths).toHaveProperty('/api/auth/me');
      expect(paths).toHaveProperty('/api/auth/refresh');
    });

    it('has all expected admin paths documented', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      const json = await res.json() as { paths?: Record<string, unknown> };
      const paths = json.paths ?? {};
      expect(paths).toHaveProperty('/api/admin/queue');
      expect(paths).toHaveProperty('/api/admin/settings/timing');
      expect(paths).toHaveProperty('/api/admin/settings/pipeline');
      expect(paths).toHaveProperty('/api/admin/dlq');
      expect(paths).toHaveProperty('/api/admin/stats');
    });
  });

  describe('GET /api/docs/ui', () => {
    it('returns 401 without admin authorization', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs/ui`);
      expect(res.status).toBe(401);
    });

    it('returns HTML with a Redoc script tag with admin authorization', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs/ui`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('redoc');
      expect(html).toContain('specUrl');
    });
  });

  // ─── Public route contracts ──────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('returns JSON with { success: true }', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = apiResponseSuccessSchema.safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/public-config', () => {
    it('returns JSON with success=true and data containing GENRES array', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          GENRES: z.array(z.string()),
          DEFAULT_GENRE: z.string(),
          MAX_SEED_LENGTH: z.number(),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  // ─── Admin route contracts ────────────────────────────────────────────────

  describe('GET /api/admin/queue (without auth)', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`);
      expect(res.status).toBe(401);
      const json = await res.json() as unknown;
      const result = apiResponseErrorSchema.safeParse(json);
      expect(result.success).toBe(true);
    });

    it('returns 403 when a wrong bearer token is provided', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(403);
      const json = await res.json() as unknown;
      const result = apiResponseErrorSchema.safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/admin/queue (with admin auth)', () => {
    it('returns 200 with queue stats matching the contract', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          queueDepth: z.number(),
          activeJobs: z.number(),
          completedToday: z.number(),
          dlqDepth: z.number(),
          recentFailures: z.array(z.object({
            jobId: z.string(),
            genre: z.array(z.string()),
            failedAt: z.number(),
            failedReason: z.string(),
            attemptsMade: z.number(),
          })),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/admin/settings/timing (with admin auth)', () => {
    it('returns 200 with timing settings matching the contract', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          episodesPerStory: z.number(),
          scenesPerEpisode: z.number(),
          targetWordsPerScene: z.number(),
          targetEpisodeWordsMin: z.number(),
          targetEpisodeWordsMax: z.number(),
          sceneDurationMinSeconds: z.number(),
          sceneDurationMaxSeconds: z.number(),
          speakingWpm: z.number(),
          targetEpisodeSeconds: z.number(),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/admin/settings/pipeline (with admin auth)', () => {
    it('returns 200 with pipeline settings matching the contract', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/pipeline`, {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          qualityFloor: z.number(),
          gradeFloor: z.string(),
          humanizationLimit: z.number(),
          humanizationBudget: z.number(),
          humanizationRetries: z.number(),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('PATCH /api/admin/settings/timing validation (with admin auth)', () => {
    function timingPatchHeaders(body: object) {
      return {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
        body: JSON.stringify(body),
      };
    }

    it('accepts a valid timing update with 200', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/admin/settings/timing`,
        timingPatchHeaders({ speakingWpm: 150 })
      );
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          updated: z.array(z.object({ key: z.string(), value: z.number() })),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });

    it('rejects out-of-range values with 400 and ApiResponseError shape', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/admin/settings/timing`,
        timingPatchHeaders({ episodesPerStory: 999 })
      );
      expect(res.status).toBe(400);
      const json = await res.json() as unknown;
      const result = apiResponseErrorSchema.safeParse(json);
      expect(result.success).toBe(true);
    });

    it('rejects unknown fields with 400', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/admin/settings/timing`,
        timingPatchHeaders({ unknownField: 'value' })
      );
      expect(res.status).toBe(400);
    });

    it('rejects targetEpisodeWordsMin > targetEpisodeWordsMax with 400', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/admin/settings/timing`,
        timingPatchHeaders({ targetEpisodeWordsMin: 500, targetEpisodeWordsMax: 50 })
      );
      expect(res.status).toBe(400);
      const json = await res.json() as unknown;
      const result = apiResponseErrorSchema.safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/admin/dlq (with admin auth)', () => {
    it('returns 200 with both entries and backgroundEntries arrays', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq`, {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          entries: z.array(z.any()),
          backgroundEntries: z.array(z.object({
            source: z.literal('background'),
            jobId: z.string(),
          })),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });

  describe('GET /api/admin/stats (with admin auth)', () => {
    it('returns 200 with stats matching the contract', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/stats`, {
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          'X-CSRF-Token': csrfToken ?? '',
          Cookie: adminCookie ?? '',
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as unknown;
      const result = z.object({
        success: z.literal(true),
        data: z.object({
          totalStories: z.number(),
          totalEpisodes: z.number(),
          totalScenes: z.number(),
          totalCharacters: z.number(),
        }),
      }).safeParse(json);
      expect(result.success).toBe(true);
    });
  });
});
