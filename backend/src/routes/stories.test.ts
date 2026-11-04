/**
 * Stories Route Tests — DELETE/PATCH/GET pagination/similarity/confidence/history
 *
 * Comprehensive tests for stories router endpoints beyond basic CRUD:
 *   - DELETE /api/stories/:id
 *   - PATCH /api/stories/:id
 *   - GET /api/stories (pagination)
 *   - GET /api/stories/:id/similarity
 *   - GET /api/stories/:id/confidence
 *   - GET /api/stories/:id/regeneration-history
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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

// Mock bcrypt so registration and login work with any password
vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue('$2b$10$hashedpassword'),
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


const STORY1_ID = 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6';
const STORY2_ID = 'b02c5b89-0dc3-44f8-b8ab-d7437a7064e7';

const mockEpisodes = [
  {
    number: 1,
    title: 'Episode 1',
    duration: 60,
    synopsis: 'Test synopsis',
    hook: 'Test hook',
    cliffhanger: 'Test cliff',
    voiceoverText: 'Test voiceover',
    musicSuggestions: ['epic'],
    soundDesign: ['ambience'],
    scenes: [
      {
        number: 1,
        narrationText: 'A long time ago in a galaxy far far away, a hero rose to face his destiny.',
        narrationEmotion: 'determined',
        duration: 30,
        imagePrompt: { content: 'image prompt', emotion: 'epic' },
        videoPrompt: { content: 'video prompt', emotion: 'dynamic' },
        cameraDirection: { type: 'wide', movement: 'pan', angle: 'low' },
        transitionType: 'cut',
        emotionalIntensity: 8,
      },
    ],
  },
];

const mockStories: Array<Record<string, unknown>> = [
  {
    id: STORY1_ID,
    title: 'Story 1',
    genre: 'adventure',
    seed: 's1',
    theme: 't1',
    status: 'complete',
    createdAt: new Date(),
    updatedAt: new Date(),
    targetAudience: null,
    embedding: new Array(1024).fill(0.1),
    isTemplate: false,
    templateId: null,
    seedStoryId: null,
    qualityScore: 85,
    qualityGrade: 'A',
    humanizationScore: 90,
    qualityRecommendations: [],
    qualityIssues: [],
    algorithmTips: [],
    alternateTitles: [],
    episodes: mockEpisodes,
    characters: [],
    environments: [],
    youtubeSeo: null,
  },
  {
    id: STORY2_ID,
    title: 'Story 2',
    genre: 'fantasy',
    seed: 's2',
    theme: 't2',
    status: 'failed',
    createdAt: new Date(),
    updatedAt: new Date(),
    targetAudience: null,
    embedding: new Array(1024).fill(0.2),
    isTemplate: false,
    templateId: null,
    seedStoryId: null,
    qualityScore: 80,
    qualityGrade: 'B',
    humanizationScore: 85,
    qualityRecommendations: [],
    qualityIssues: [],
    algorithmTips: [],
    alternateTitles: [],
    episodes: mockEpisodes,
    characters: [],
    environments: [],
    youtubeSeo: null,
  },
];

// Track users "created" via the mock user.create so findUnique can return them
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
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({}),
  },
  generationLog: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({}),
  },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrismaClient)),
};

(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

describe('stories route', () => {
  let port: number;
  let server: import('http').Server;
  let cookie = '';
  const csrfToken = 'a'.repeat(64);

  beforeAll(async () => {
    const { app } = await import('../server.js');
    server = (app as import('express').Express).listen(0) as import('http').Server;
    port = (server.address() as import('net').AddressInfo).port;

    // Register a unique user so each test run gets a fresh identity.
    // The real bcrypt and jsonwebtoken are used (no mocks for those modules).
    const username = `stories_test_${Date.now()}`;
    const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'stories-test-pw' }),
    });
    if (!reg.ok) {
      const text = await reg.text();
      throw new Error(`register failed: ${reg.status} ${text}`);
    }
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

  // =============================================================================
  // DELETE /api/stories/:id
  // =============================================================================
  describe('DELETE /api/stories/:id', () => {
    it('returns 404 for non-existent story', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/nonexistent-id`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for malformed UUID', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/not-a-valid-uuid`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      });
      expect(res.status).toBe(400);
    });

    it('deletes an existing story and returns success', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY2_ID}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      });
      expect(res.status).toBe(200);
    });

    it('requires CSRF token (403 without)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    });
  });

  // =============================================================================
  // PATCH /api/stories/:id
  // =============================================================================
  describe('PATCH /api/stories/:id', () => {
    it('updates story theme', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ theme: 'updated theme' }),
      });
      expect(res.status).toBe(200);
    });

    it('updates story title', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title: 'New Title' }),
      });
      expect(res.status).toBe(200);
    });

    it('updates story status (failed→draft, the only API-permitted transition)', async () => {
      // Fix #28: the API is only permitted to reset failed→draft. STORY2_ID is
      // the only mock story in 'failed' status. STORY1_ID is 'complete' (terminal)
      // and would be rejected by the state machine.
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY2_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ status: 'draft' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects invalid status value', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ status: 'invalid_status' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects unknown fields (strict)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ unknownField: 'value' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent story', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/nonexistent-id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ theme: 'test' }),
      });
      expect(res.status).toBe(400);
    });

    it('requires CSRF token (403 without)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ theme: 'test' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // =============================================================================
  // PATCH /api/stories/:id/episodes/:episodeNumber — M2 noHtml sanitization
  // =============================================================================
  describe('PATCH /api/stories/:id/episodes/:episodeNumber (M2 noHtml)', () => {
    it('rejects HTML in the episode title', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/episodes/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title: '<script>alert(1)</script>' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects HTML in the episode hook', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/episodes/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ hook: '<b>clickbait</b>' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects HTML in the episode synopsis and cliffhanger', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/episodes/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ synopsis: '<img src=x onerror=alert(1)>', cliffhanger: '<i>x</i>' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // =============================================================================
  // GET /api/stories — pagination
  // =============================================================================
  describe('GET /api/stories pagination', () => {
    it('returns paginated stories with default limit', async () => {
      mockPrismaClient.story.count.mockClear();
      const res = await fetch(`http://127.0.0.1:${port}/api/stories`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { stories: unknown[]; total: number; hasMore: boolean } };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.stories)).toBe(true);
      expect(typeof body.data.total).toBe('number');
      // PERF-LIST-TOTAL: first page always computes the total.
      expect(mockPrismaClient.story.count).toHaveBeenCalledTimes(1);
   });

    it('respects limit parameter', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=1`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { stories: unknown[]; hasMore: boolean } };
      expect(body.data.stories.length).toBeLessThanOrEqual(1);
    });

    it('rejects limit > 100', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=200`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });

    it('accepts cursor-based pagination and skips the COUNT query', async () => {
      mockPrismaClient.story.count.mockClear();
      const cursorDate = new Date(Date.now() + 86400000).toISOString();
      const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=1&cursor=${encodeURIComponent(cursorDate)}`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      // PERF-LIST-TOTAL: cursor pages (page 2+) must not pay for the COUNT.
      // The UI only reads `total` from pages[0] (lib/query/stories.ts).
      expect(mockPrismaClient.story.count).not.toHaveBeenCalled();
      const body = await res.json() as { success: boolean; data: { total: number | null } };
      expect(body.data.total).toBeNull();
    });

    it('rejects negative limit', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories?limit=-1`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });
  });

  // =============================================================================
  // GET /api/stories/:id/similarity
  // =============================================================================
  describe('GET /api/stories/:id/similarity', () => {
    it('returns similarity matrix for valid story', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/similarity`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 for malformed ID', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/invalid-id/similarity`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });

    it('accepts episodeNumber query param', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/similarity?episodeNumber=1`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('rejects episodeNumber > 10', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/similarity?episodeNumber=99`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });
  });

  // =============================================================================
  // GET /api/stories/:id/confidence
  // =============================================================================
  describe('GET /api/stories/:id/confidence', () => {
    it('returns confidence scores for valid story', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/confidence`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 for malformed ID', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/invalid-id/confidence`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });

    it('accepts episodeNumber query param', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/confidence?episodeNumber=1`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });
  });

  // =============================================================================
  // GET /api/stories/:id/regeneration-history
  // =============================================================================
  describe('GET /api/stories/:id/regeneration-history', () => {
    it('returns history for valid story', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/regeneration-history`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 for malformed ID', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/invalid-id/regeneration-history`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });

    it('accepts limit and offset params', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/regeneration-history?limit=10&offset=0`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it('rejects limit > 200', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/regeneration-history?limit=500`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });

    it('rejects negative offset', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/regeneration-history?offset=-1`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    });
  });
});