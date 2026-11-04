/**
 * Stories Export Route Tests — All 6 formats + invalid format
 *
 * Tests POST /api/stories/:id/export with all format variants:
 *   - json, csv, txt, ssml, srt, vtt
 *   - invalid format returns 400
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


const STORY1_ID = 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6';

const mockEpisodes = [
  {
    number: 1,
    title: 'Episode 1',
    duration: 60,
    synopsis: 'Test synopsis',
    hook: 'Test hook',
    cliffhanger: 'Test cliff',
    voiceoverText: 'Test voiceover text for export testing.',
    musicSuggestions: ['epic'],
    soundDesign: ['ambience'],
    scenes: [
      {
        number: 1,
        narrationText: 'A long time ago in a galaxy far far away, a hero rose to face his destiny with courage.',
        narrationEmotion: 'determined',
        duration: 30,
        imagePrompt: { content: 'image prompt for scene 1', emotion: 'epic' },
        videoPrompt: { content: 'video prompt for scene 1', emotion: 'dynamic' },
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
    title: 'Test Story Export',
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
];

const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ reltuples: BigInt(1) }]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      return mockStories.find((s) => s.id === where.id) ?? null;
    }),
    findMany: vi.fn().mockResolvedValue(mockStories),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(1),
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

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as http.Server;
  port = (server.address() as import('net').AddressInfo).port;
  const username = `stories_export_${Date.now()}`;
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

// =============================================================================
// POST /api/stories/:id/export — all 6 formats
// =============================================================================
describe('POST /api/stories/:id/export — all formats', () => {
  const formats: Array<{ fmt: string; contentType?: RegExp; expectContent?: RegExp }> = [
    { fmt: 'json', contentType: /application\/json/ },
    { fmt: 'csv', contentType: /text\/csv/ },
    { fmt: 'ssml', contentType: /application\/ssml\+xml/ },
    { fmt: 'txt', contentType: /text\/plain/ },
    { fmt: 'srt', contentType: /application\/x-subrip/ },
    { fmt: 'vtt', contentType: /text\/vtt/ },
  ];

  for (const { fmt, contentType, expectContent } of formats) {
    it(`POST /api/stories/:id/export with format=${fmt} returns expected status`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
        method: 'POST',
        headers: csrfHeaders(),
        body: JSON.stringify({ format: fmt }),
      });
      expect(res.status).toBe(200);
      if (res.status === 200 && contentType) {
        const ct = res.headers.get('Content-Type');
        expect(ct).toMatch(contentType);
      }
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
      body: JSON.stringify({ format: 'invalid_format_xyz' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/stories/:id/export with malformed story id returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/nonexistent-id/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/stories/:id/export with malformed ID returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/not-a-uuid/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/stories/:id/export requires CSRF token (403 without)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'json' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/stories/:id/export sets Content-Disposition header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json' }),
    });
    if (res.status === 200) {
      const cd = res.headers.get('Content-Disposition');
      expect(cd).toContain('attachment');
    }
  });

  it('POST /api/stories/:id/export accepts content option', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json', content: 'voiceover-only' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/stories/:id/export accepts includeVoiceover flag', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json', includeVoiceover: false }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/stories/:id/export accepts includePrompts flag', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json', includePrompts: false }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/stories/:id/export accepts includeMetadata flag', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/${STORY1_ID}/export`, {
      method: 'POST',
      headers: csrfHeaders(),
      body: JSON.stringify({ format: 'json', includeMetadata: false }),
    });
    expect(res.status).toBe(200);
  });
});