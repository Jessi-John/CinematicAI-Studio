/**
 * Admin Extended Route Tests — Queue/restart/timing boundary tests
 *
 * Tests for admin router endpoints beyond basic auth:
 *   - GET /api/admin/queue (queue depth and DLQ status)
 *   - POST /api/admin/queue/:jobId/restart (boundary tests)
 *   - GET /api/admin/settings/timing
 *   - PATCH /api/admin/settings/timing (boundary values)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';

// Mock BullMQ queues so server starts without Redis
const mockQueue = {
  getWaitingCount: vi.fn().mockResolvedValue(5),
  getActiveCount: vi.fn().mockResolvedValue(2),
  getCompletedCount: vi.fn().mockResolvedValue(100),
  getJobCounts: vi.fn().mockResolvedValue({ failed: 3, completed: 100, waiting: 5, active: 2 }),
  getJobs: vi.fn().mockResolvedValue([]),
  add: vi.fn().mockResolvedValue({ id: 'new-job-id' }),
 close: vi.fn().mockResolvedValue(undefined),
};

const mockDlq = {
  getJobCounts: vi.fn().mockResolvedValue({ failed: 3 }),
  getJobs: vi.fn().mockImplementation(async (_states: string[], _start: number, _end: number) => {
    return [
      {
        id: 'dlq-job-1',
        data: {
          jobId: 'story-123',
          genre: ['fantasy'],
          _failedAt: Date.now() - 3600000,
          _failedReason: 'AI timeout',
        },
        attemptsMade: 2,
      },
    ];
  }),
  getJob: vi.fn().mockResolvedValue(null),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  // REL-XXX: The proxy must return proper values for queue methods used by admin routes.
  // Previously returned () => ({}) for all methods, causing JSON serialization to fail.
  storyQueue: new Proxy(
    {},
    {
      get: (_target: object, prop: string) => {
        if (prop === 'getWaitingCount') return async () => 0;
        if (prop === 'getActiveCount') return async () => 0;
        if (prop === 'getCompletedCount') return async () => 0;
        if (prop === 'getJobs') return async () => [];
        return async () => ({});
      },
    }
  ),
  storyDlq: new Proxy(
    {},
    {
      get: (_target: object, prop: string) => {
        if (prop === 'getJobCounts') return async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 });
        if (prop === 'getJobs') return async () => [];
        return async () => ({});
      },
    }
  ),
  getStoryQueue: () => mockQueue,
  getStoryDlq: () => mockDlq,
  getBackgroundDlq: () => ({
    getJobs: vi.fn().mockResolvedValue([]),
    getWaitingCount: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  }),
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
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => {
      const map: Record<string, string> = {
        episodes_per_story: '8',
        scenes_per_episode: '4',
        target_words_per_scene: '50',
        target_words_per_episode_min: '200',
        target_words_per_episode_max: '300',
        scene_duration_min_seconds: '10',
        scene_duration_max_seconds: '45',
        speaking_wpm: '150',
        target_episode_seconds: '180',
        quality_floor: '70',
        grade_floor: 'C',
        humanization_score_limit: '80',
        humanization_story_budget: '50',
        humanization_story_quality_retries: '2',
      };
      return map[where.key] ? { key: where.key, value: map[where.key] } : null;
    }),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
      return { key: where.key, value: update.value ?? create.value };
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

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;
  const username = `admin_extended_${Date.now()}`;
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

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRF-Token': 'a'.repeat(64),
    'Authorization': 'Bearer test_admin_key',
  };
}

// =============================================================================
// GET /api/admin/queue
// =============================================================================
describe('GET /api/admin/queue', () => {
  it('requires admin auth (403 without bearer)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(403);
  });

  it('returns queue stats with valid admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { queueDepth: number; activeJobs: number } };
    expect(body.success).toBe(true);
    expect(typeof body.data.queueDepth).toBe('number');
    expect(typeof body.data.activeJobs).toBe('number');
  });
});

// =============================================================================
// POST /api/admin/queue/:jobId/restart
// =============================================================================
describe('POST /api/admin/queue/:jobId/restart', () => {
  it('returns 400 for malformed jobId', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/not-a-valid-job-id/restart`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/Invalid job ID/i);
  });

  it('returns 404 when job not found in DLQ', async () => {
    // REL-XXX: Using __setStoryDlq injection point to override the module-level
    // storyDlq reference that admin.ts captured at import time. Without this,
    // vi.mock hoisting causes the test's mockResolvedValueOnce to have no effect.
    const { __setStoryDlq } = await import('../routes/admin.js');
    const testDlq = {
      ...mockDlq,
      getJob: vi.fn().mockResolvedValue(null),
      getJobs: vi.fn().mockResolvedValue([]),
    };
    __setStoryDlq(testDlq as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/c12345678901234567890123/restart`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
    } finally {
      __setStoryDlq(mockDlq as never);
    }
  });

  it('returns 400 for invalid UUID format', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz/restart`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it('requires admin auth (403 without bearer)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/c12345678901234567890123/restart`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// GET /api/admin/settings/timing
// =============================================================================
describe('GET /api/admin/settings/timing', () => {
  it('requires admin auth (403 without bearer)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    // Admin endpoints check the bearer token before role checks.
    expect(res.status).toBe(403);
  });

  it('returns timing settings with valid admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, number> };
    expect(body.success).toBe(true);
    expect(typeof body.data.speakingWpm).toBe('number');
  });
});

// =============================================================================
// PATCH /api/admin/settings/timing — boundary values
// =============================================================================
describe('PATCH /api/admin/settings/timing — boundary tests', () => {
  it('accepts episodesPerStory at boundary (1)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ episodesPerStory: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts episodesPerStory at boundary (20)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ episodesPerStory: 20 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects episodesPerStory below minimum (0)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ episodesPerStory: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects episodesPerStory above maximum (21)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ episodesPerStory: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts speakingWpm at boundary (50)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 50 }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts speakingWpm at boundary (300)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 300 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects speakingWpm below minimum (49)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 49 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects speakingWpm above maximum (301)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 301 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts targetEpisodeSeconds at boundary (10)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ targetEpisodeSeconds: 10 }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts targetEpisodeSeconds at boundary (300)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ targetEpisodeSeconds: 300 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects targetEpisodeSeconds below minimum (9)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ targetEpisodeSeconds: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects targetEpisodeSeconds above maximum (301)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ targetEpisodeSeconds: 301 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts sceneDurationMinSeconds at boundary (1)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ sceneDurationMinSeconds: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts sceneDurationMaxSeconds at boundary (60)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ sceneDurationMaxSeconds: 60 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects sceneDurationMaxSeconds below sceneDurationMinSeconds', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ sceneDurationMinSeconds: 30, sceneDurationMaxSeconds: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-integer values', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 150.5 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric values', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ speakingWpm: 'fast' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty body (no valid fields)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('accepts multiple valid fields in one request', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({
        episodesPerStory: 10,
        speakingWpm: 160,
        targetEpisodeSeconds: 200,
      }),
    });
    expect(res.status).toBe(200);
  });

  it('requires admin auth (403 without bearer)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakingWpm: 150 }),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// DLQ routes — list readability + restart/requeue/delete (C2 regression)
// =============================================================================
const DLQ_CUID = 'c12345678901234567890123';

function makeDlqJob(overrides: Record<string, unknown> = {}) {
  return {
    id: `dlq-${DLQ_CUID}`,
    data: {
      jobId: DLQ_CUID,
      genre: ['fantasy'],
      seed: 'a seed',
      userId: 'user-42',
      webhookUrl: 'https://example.com/hook',
      requestId: 'req-1',
      _failedAt: Date.now() - 1000,
      _failedReason: 'AI timeout',
      ...overrides,
    },
    attemptsMade: 3,
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GET /api/admin/dlq', () => {
  it('reads waiting DLQ entries, not just failed (list readability fix)', async () => {
    const { __setStoryDlq } = await import('../routes/admin.js');
    const getJobsSpy = vi.fn().mockResolvedValue([
      { id: 'dlq-1', data: { jobId: DLQ_CUID, genre: ['fantasy'], _failedAt: 123, _failedReason: 'boom' }, attemptsMade: 3 },
    ]);
    __setStoryDlq({ ...mockDlq, getJobs: getJobsSpy } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq`, { headers: adminHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { entries: Array<{ jobId: string }> } };
      expect(body.success).toBe(true);
      expect(body.data.entries).toHaveLength(1);
      // The DLQ has no consuming worker, so entries are 'waiting'. The query
      // must include 'waiting' (previously it read only 'failed' → always empty).
      const statesArg = getJobsSpy.mock.calls[0]![0] as string[];
      expect(statesArg).toContain('waiting');
    } finally {
      __setStoryDlq(mockDlq as never);
    }
  });
});

describe('POST /api/admin/queue/:jobId/restart — userId preservation (C2)', () => {
  it('re-enqueues with userId/webhookUrl preserved and DLQ metadata stripped', async () => {
    const { __setStoryDlq, __setStoryQueue } = await import('../routes/admin.js');
    const { storyQueue } = await import('../queue/index.js');
    const addSpy = vi.fn().mockResolvedValue({ id: 'new-job-1' });
    const dlqJob = makeDlqJob();
    __setStoryDlq({ ...mockDlq, getJob: vi.fn().mockResolvedValue(dlqJob), getJobs: vi.fn().mockResolvedValue([]) } as never);
    __setStoryQueue({ add: addSpy } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/${DLQ_CUID}/restart`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      expect(addSpy).toHaveBeenCalledTimes(1);
      const payload = addSpy.mock.calls[0]![1] as Record<string, unknown>;
      // Death-loop fix: userId must survive so the pipeline does not fall back
      // to 'unknown' and violate the RESTRICT stories.userId FK.
      expect(payload.userId).toBe('user-42');
      expect(payload.webhookUrl).toBe('https://example.com/hook');
      expect(payload.retryFromDlq).toBe(true);
      expect(payload._failedReason).not.toBeDefined();
      expect(payload._failedAt).not.toBeDefined();
      // The DLQ entry is removed after a successful re-enqueue.
      expect(dlqJob.remove).toHaveBeenCalled();
    } finally {
      __setStoryDlq(mockDlq as never);
      __setStoryQueue(storyQueue as never);
    }
  });
});

describe('POST /api/admin/dlq/:jobId/requeue', () => {
  it('preserves userId, sets retryFromDlq, and removes the DLQ entry', async () => {
    const { __setStoryDlq, __setStoryQueue } = await import('../routes/admin.js');
    const { storyQueue } = await import('../queue/index.js');
    const addSpy = vi.fn().mockResolvedValue({ id: 'new-job-2' });
    const removeSpy = vi.fn().mockResolvedValue(undefined);
    const dlqJob = makeDlqJob();
    __setStoryDlq({
      ...mockDlq,
      getJob: vi.fn().mockResolvedValue(dlqJob),
      getJobs: vi.fn().mockResolvedValue([]),
      remove: removeSpy,
    } as never);
    __setStoryQueue({ add: addSpy } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq/${DLQ_CUID}/requeue`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      expect(addSpy).toHaveBeenCalledTimes(1);
      const payload = addSpy.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload.userId).toBe('user-42');
      expect(payload.retryFromDlq).toBe(true);
      expect(payload._failedReason).not.toBeDefined();
      // Removed by the actual BullMQ job id (dlq-<cuid>), not the user param.
      expect(removeSpy).toHaveBeenCalledWith(`dlq-${DLQ_CUID}`);
    } finally {
      __setStoryDlq(mockDlq as never);
      __setStoryQueue(storyQueue as never);
    }
  });

  it('returns 404 when the job is not in the DLQ', async () => {
    const { __setStoryDlq } = await import('../routes/admin.js');
    __setStoryDlq({ ...mockDlq, getJob: vi.fn().mockResolvedValue(null), getJobs: vi.fn().mockResolvedValue([]) } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq/${DLQ_CUID}/requeue`, {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
    } finally {
      __setStoryDlq(mockDlq as never);
    }
  });
});

describe('DELETE /api/admin/dlq/:jobId', () => {
  it('removes the DLQ entry by its BullMQ job id', async () => {
    const { __setStoryDlq } = await import('../routes/admin.js');
    const removeSpy = vi.fn().mockResolvedValue(undefined);
    const dlqJob = makeDlqJob();
    __setStoryDlq({
      ...mockDlq,
      getJob: vi.fn().mockResolvedValue(dlqJob),
      getJobs: vi.fn().mockResolvedValue([]),
      remove: removeSpy,
    } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq/${DLQ_CUID}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { jobId: string } };
      expect(body.success).toBe(true);
      expect(removeSpy).toHaveBeenCalledWith(`dlq-${DLQ_CUID}`);
    } finally {
      __setStoryDlq(mockDlq as never);
    }
  });

  it('returns 404 when the job is not in the DLQ', async () => {
    const { __setStoryDlq } = await import('../routes/admin.js');
    __setStoryDlq({ ...mockDlq, getJob: vi.fn().mockResolvedValue(null), getJobs: vi.fn().mockResolvedValue([]) } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq/${DLQ_CUID}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
    } finally {
      __setStoryDlq(mockDlq as never);
    }
  });

  it('requires admin auth (403 without bearer)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/dlq/${DLQ_CUID}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(403);
  });
});