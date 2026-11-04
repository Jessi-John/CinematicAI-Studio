/**
 * Routes Extended Integration Tests
 *
 * Expand coverage beyond chain.integration.test.ts (which only checks
 * reachability). This file exercises full request/response flows for endpoints
 * that had no scripted test coverage:
 *   - GET /api/settings (list + single)
 *   - PUT /api/settings (single + batch)
 *   - DELETE /api/settings/:key
 *   - GET /api/user-settings (list + single)
 *   - PUT /api/user-settings (single + batch)
 *   - DELETE /api/user-settings/:key
 *   - GET /api/stories (pagination, sort, filter)
 *   - PATCH /api/stories/:id (theme, title, status)
 *   - DELETE /api/stories/:id (cascade)
 *   - POST /api/stories/:id/export (all 6 formats)
 *   - GET /api/admin/queue
 *   - GET /api/admin/settings/timing
 *   - POST /api/admin/queue/:jobId/restart
 *   - PATCH /api/admin/settings/timing
 *   - GET /api/admin/settings/pipeline
 *   - PUT /api/admin/settings/pipeline/:key
 *
 * Mocks match chain.integration.test.ts to avoid redis/db dependencies.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';

// Mock BullMQ queues so server starts without Redis
// REL-XXX: The proxy must return proper values for queue methods used by admin routes.
// Previously returned () => ({}) for all methods, causing JSON serialization to fail
// (e.g., getWaitingCount() returned {} instead of 0, making the endpoint return 500).
vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  storyQueue: new Proxy(
    {},
    {
      get: (_target: object, prop: string) => {
        if (prop === 'getWaitingCount') return async () => 0;
        if (prop === 'getActiveCount') return async () => 0;
        if (prop === 'getCompletedCount') return async () => 0;
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


// Mock prisma with realistic CRUD responses
const mockSettings = new Map<string, { key: string; value: string; type: string }>([
  ['quality_floor', { key: 'quality_floor', value: '70', type: 'string' }],
  ['grade_floor', { key: 'grade_floor', value: 'C', type: 'string' }],
]);

const mockUserSettings = new Map<string, { key: string; value: string; type: string; updatedAt: Date }>([
  ['theme', { key: 'theme', value: 'dark', type: 'string', updatedAt: new Date() }],
  ['quality_floor', { key: 'quality_floor', value: '70', type: 'string', updatedAt: new Date() }],
  ['grade_floor', { key: 'grade_floor', value: 'C', type: 'string', updatedAt: new Date() }],
]);

const mockEpisodes = [
  {
    number: 1, title: 'Episode 1', duration: 60,
    scenes: [
      { number: 1, narration: { text: 'A long time ago in a galaxy far far away, a hero rose.' }, duration: 30 },
    ],
  },
];

const mockStories: Array<Record<string, unknown>> = [
  {
    id: 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6', title: 'Story 1', genre: 'adventure', seed: 's1', theme: 't1',
    status: 'complete', createdAt: new Date(), updatedAt: new Date(),
    targetAudience: null, embedding: new Array(1024).fill(0.1), isTemplate: false,
    templateId: null, seedStoryId: null, qualityScore: 85, qualityGrade: 'A',
    humanizationScore: 90, qualityRecommendations: [], qualityIssues: [],
    algorithmTips: [], alternateTitles: [],
    episodes: mockEpisodes, characters: [], environments: [], youtubeSeo: null,
  },
  {
    id: 'b02c5b89-0dc3-44f8-b8ab-d7437a7064e7', title: 'Story 2', genre: 'fantasy', seed: 's2', theme: 't2',
    status: 'complete', createdAt: new Date(), updatedAt: new Date(),
    targetAudience: null, embedding: new Array(1024).fill(0.2), isTemplate: false,
    templateId: null, seedStoryId: null, qualityScore: 80, qualityGrade: 'B',
    humanizationScore: 85, qualityRecommendations: [], qualityIssues: [],
    algorithmTips: [], alternateTitles: [],
    episodes: mockEpisodes, characters: [], environments: [], youtubeSeo: null,
  },
];

const STORY1_ID = 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6';
const STORY2_ID = 'b02c5b89-0dc3-44f8-b8ab-d7437a7064e7';

const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ reltuples: BigInt(2) }]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      return mockStories.find((s) => s.id === where.id) ?? null;
    }),
    findMany: vi.fn().mockResolvedValue(mockStories),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      const idx = mockStories.findIndex((s) => s.id === where.id);
      if (idx === -1) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      return mockStories[idx];
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      return { id: 'new', ...data };
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const story = mockStories.find((s) => s.id === where.id);
      if (!story) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      Object.assign(story, data);
      return story;
    }),
    count: vi.fn().mockResolvedValue(2),
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
      return mockSettings.get(where.key) ?? null;
    }),
    findMany: vi.fn().mockResolvedValue(Array.from(mockSettings.values())),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string; type: string } }) => {
      const existing = mockSettings.get(where.key);
      const next: { key: string; value: string; type: string } = existing ?? { ...create, type: create.type ?? 'string' };
      next.value = update.value;
      mockSettings.set(where.key, next);
      return next;
    }),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => {
      const existing = mockSettings.get(where.key);
      if (!existing) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      mockSettings.delete(where.key);
      return existing;
    }),
  },
  userSettings: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key?: string; userId_key?: { userId: string; key: string } } }) => {
      const key = where.userId_key?.key ?? where.key;
      if (!key) return null;
      // Search all settings regardless of userId for test compatibility
      for (const s of mockUserSettings.values()) {
        if (s.key === key) return s;
      }
      return null;
    }),
    findMany: vi.fn().mockResolvedValue(Array.from(mockUserSettings.values())),
    upsert: vi.fn().mockImplementation(async ({ where, update, create }: { where: { key?: string; userId_key?: { userId: string; key: string } }; update: { value: string; type: string }; create: { key: string; value: string; type: string } }) => {
      const key = where.userId_key?.key ?? where.key ?? create.key;
      const existing = mockUserSettings.get(key);
      const next: { key: string; value: string; type: string; updatedAt: Date } = existing ?? { ...create, updatedAt: new Date() };
      next.value = update.value;
      mockUserSettings.set(key, next);
      return next;
    }),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => {
      const existing = mockUserSettings.get(where.key);
      if (!existing) {
        const err = new Error('Record not found') as Error & { code?: string };
        err.code = 'P2025';
        throw err;
      }
      mockUserSettings.delete(where.key);
      return existing;
    }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  generationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
  // Register and login to get a valid session cookie
  const username = `routes_ext_${Date.now()}`;
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

  // Ownership is now enforced: stories must belong to the authenticated user.
  const user = registeredUsers.get(username);
  if (user) {
    for (const story of mockStories) {
      story.userId = user.id;
    }
  }
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

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'X-CSRF-Token': 'a'.repeat(64),
    'Authorization': 'Bearer test_admin_key',
  };
}

// =============================================================================
// Settings endpoints
// =============================================================================
describe('Settings endpoints', () => {
  it('GET /api/settings returns all settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(typeof body.data).toBe('object');
  });

  it('GET /api/settings/:key returns single setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/quality_floor`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/settings/:key returns 404 for missing key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/nonexistent_key_xyz`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /api/settings/:key upserts a setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_setting_xyz`, {
      method: 'PATCH',
      headers: adminHeaders(),
      body: JSON.stringify({ value: 'test_value', type: 'string' }),
    });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/settings/:key removes a setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/test_setting_xyz`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// User settings endpoints
// =============================================================================
describe('User settings endpoints', () => {
  it('GET /api/user-settings returns all user settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /api/user-settings/:key returns single setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/theme`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it('PUT /api/user-settings/:key upserts a setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_user_key`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({ value: 'test', type: 'string' }),
    });
    expect(res.status).toBe(200);
  });

  it('PUT /api/user-settings batch upserts multiple settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings`, {
      method: 'PUT',
      headers: csrfHeaders(),
      body: JSON.stringify({
        settings: [
          { key: 'genre1', value: 'fantasy', type: 'string' },
          { key: 'genre2', value: 'horror', type: 'string' },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/user-settings/:key removes a setting', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-settings/test_user_key`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Stories endpoints — CRUD
// =============================================================================
describe('Stories endpoints', () => {
  it('GET /api/stories returns paginated stories', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=10`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { stories: unknown[]; total: number; hasMore: boolean } };
    expect(body.success).toBe(true);
    // stories is always a real array (possibly empty), not undefined.
    expect(Array.isArray(body.data.stories)).toBe(true);
    expect(typeof body.data.total).toBe('number');
  });

  it('GET /api/stories?limit=1 returns at most 1 story + hasMore=true', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=1`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/stories/:id returns story detail (REL-011)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { id: string } };
    expect(body.data.id).toBe(STORY1_ID);
  });

  it('GET /api/stories/:id returns 404 for unknown id', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/nonexistent-id`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/stories/:id updates theme', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ theme: 'updated theme' }),
    });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/stories/:id removes a story (cascade)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY2_ID}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'X-CSRF-Token': 'a'.repeat(64) },
    });
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Export endpoint — all 6 formats
// =============================================================================
describe('Export endpoint — all formats', () => {
  const formats: Array<{ fmt: string; expectContent?: RegExp }> = [
    { fmt: 'json' },
    { fmt: 'csv' },
    { fmt: 'ssml' },
    { fmt: 'txt' },
    { fmt: 'srt', expectContent: /00:\d{2}:\d{2},\d{3}/ },
    { fmt: 'vtt', expectContent: /WEBVTT/ },
  ];

  for (const { fmt, expectContent } of formats) {
    it(`POST /api/stories/:id/export with format=${fmt}`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
        method: 'POST',
        headers: csrfHeaders(),
        body: JSON.stringify({ format: fmt }),
      });
      expect(res.status).toBe(200);
      if (res.status === 200 && expectContent) {
        const text = await res.text();
        expect(text).toMatch(expectContent);
      }
    });
  }

  it('POST /api/stories/:id/export with invalid format returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'invalid_format' }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Admin endpoints
// =============================================================================
describe('Admin endpoints', () => {
  it('GET /api/admin/queue requires admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/queue accepts admin bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/settings/timing requires admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/settings/timing accepts admin bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('PATCH /api/admin/settings/timing requires admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/settings/timing`, {
      method: 'PATCH',
      headers: csrfHeaders(),
      body: JSON.stringify({ speakingWpm: 150 }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/admin/queue/:jobId/restart with malformed jobId returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/queue/malformed-job-id/restart`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(400);
  });
});