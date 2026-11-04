import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const AUTH_USER_ID = 'gen-test-auth-user-001';
const AUTH_USERNAME = 'gen_test_user';
const STORY_ID = 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6';
const CSRF_TOKEN = 'a'.repeat(64);

const mockJob = {
  id: 'mock-job-id',
  data: { jobId: 'mock-job-id', userId: AUTH_USER_ID, storyId: STORY_ID },
  getState: async () => 'completed' as const,
  progress: 100,
};

vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  storyQueue: {
    add: vi.fn(async () => mockJob),
    getJob: vi.fn(async () => mockJob),
    close: async () => {},
  },
  storyDlq: { add: async () => ({}), close: async () => {} },
  getStoryQueue: () => ({ add: async () => mockJob, getJob: async () => mockJob, close: async () => {} }),
  getStoryDlq: () => ({ add: async () => ({}), close: async () => {} }),
  addStoryJob: async () => mockJob,
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

vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    hash: vi.fn().mockResolvedValue('$2b$10$hashedpassword'),
  },
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

const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();
registeredUsers.set(AUTH_USERNAME, { id: AUTH_USER_ID, username: AUTH_USERNAME, role: 'user', passwordHash: '$2b$10$prehashed' });

const mockStories: Array<Record<string, unknown>> = [
  {
    id: STORY_ID,
    title: 'Test Story',
    genre: 'fantasy',
    seed: 'test-seed',
    theme: 'friendship',
    status: 'completed',
    userId: AUTH_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    embedding: null,
    episodes: [],
    characters: [],
    environments: [],
    youtubeSeo: null,
    generationLogs: [],
  },
];

const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ reltuples: BigInt(2) }]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      return mockStories.find((s) => s.id === where.id) ?? null;
    }),
    findMany: vi.fn().mockResolvedValue(mockStories),
    create: vi.fn().mockImplementation(async ({ data }: { data: { username: string } }) => ({
      id: `new-${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date(),
    })),
    update: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      const existing = mockStories.find((s) => s.id === where.id);
      if (!existing) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      return existing;
    }),
    delete: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
      const idx = mockStories.findIndex((s) => s.id === where.id);
      if (idx === -1) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      return mockStories[idx];
    }),
    count: vi.fn().mockResolvedValue(2),
    aggregate: vi.fn().mockResolvedValue({ _count: { id: 2 } }),
  },
  user: {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { username?: string } }) => {
      if (where.username) return registeredUsers.get(where.username) ?? null;
      return null;
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: { username: string; passwordHash: string } }) => {
      const user = { id: `user-${Date.now()}`, username: data.username, role: 'user', passwordHash: data.passwordHash, createdAt: new Date(), updatedAt: new Date() };
      registeredUsers.set(data.username, user);
      return user;
    }),
    findFirst: vi.fn().mockImplementation(async () => registeredUsers.values().next().value ?? null),
  },
  youTubeSEO: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
  systemSettings: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: unknown) => {
    if (typeof fn === 'function') return fn(mockPrismaClient);
    return fn;
  }),
};

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

vi.mock('../lib/copyright-filter.js', () => ({
  checkText: vi.fn().mockImplementation((text: string) => {
    if (text.toLowerCase().includes('disney') || text.toLowerCase().includes('marvel')) {
      return { clean: false, hits: ['Disney', 'Marvel'] };
    }
    return { clean: true, hits: [] };
  }),
  scanObjectForMonetization: vi.fn().mockReturnValue([]),
}));

vi.mock('../services/similarity.js', () => ({
  findDuplicateConcept: vi.fn().mockResolvedValue(null),
  SEMANTIC_DUP_THRESHOLD: 0.85,
  LEXICAL_HARD_BLOCK: 0.95,
  checkNewContentSimilarity: vi.fn().mockResolvedValue({ unique: true, score: 0 }),
}));

vi.mock('../services/episode-regeneration.js', () => ({
  regenerateEpisode: vi.fn().mockResolvedValue({ regenerated: true, episodeNumber: 1 }),
}));

vi.mock('../services/scene-regeneration.js', () => ({
  regenerateScene: vi.fn().mockResolvedValue({ regenerated: true, sceneNumber: 1, episodeNumber: 1, newNarration: 'test', retryCount: 0 }),
}));

vi.mock('../services/story-regeneration.js', () => ({
  regenerateStory: vi.fn().mockResolvedValue({ storyId: 'new-story-id', replacedStoryId: 'old-story-id' }),
  getRegenerationTimeoutMs: vi.fn(() => 12 * 60 * 1000),
}));

vi.mock('../services/generation-logger.js', () => ({
  getGenerationStatus: vi.fn().mockResolvedValue({ state: 'completed', progress: 100 }),
  logRegeneration: vi.fn().mockResolvedValue(undefined),
}));

let port: number;
let server: import('http').Server;
let cookie = '';

beforeAll(async () => {
  const { app } = await import('../server.js');
  server = (app as import('express').Express).listen(0) as import('http').Server;
  port = (server.address() as import('net').AddressInfo).port;

  const reg = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USERNAME, password: 'any-password' }),
  });
  const rawCookies = reg.headers.get('set-cookie') || '';
  const cookieArr = rawCookies.split(',').map(c => c.split(';')[0]!.trim());
  const accessToken = cookieArr.find(c => c.startsWith('access_token='));
  cookie = `${accessToken!}; XSRF-TOKEN=${CSRF_TOKEN}`;
}, 30000);

afterAll(() => {
  server?.close();
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: cookie, 'X-CSRF-Token': CSRF_TOKEN, ...extra };
}

describe('POST /api/stories/generate', () => {
  it('returns 401 without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genre: ['fantasy'] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 without genre', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 with empty genre array', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 with invalid genre', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['nonexistent-genre'] }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 with copyright-protected seed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'], seed: 'a disney story' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.error).toBe('Copyright-protected term in seed');
  });

  it('returns 409 with duplicate story', async () => {
    const similarityModule = await import('../services/similarity.js');
    vi.mocked(similarityModule.findDuplicateConcept).mockResolvedValueOnce({
      id: 'dup-id',
      title: 'Duplicate Story',
      score: 0.96,
      via: 'lexical',
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'], seed: 'duplicate concept' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.error).toBe('Duplicate story concept detected');
  });

  it('ignores duplicate when forceNew=true', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'], seed: 'force new', forceNew: true }),
    });
    expect(res.status).toBe(202);
  });

  it('returns 202 with valid genre', async () => {
    const similarityModule = await import('../services/similarity.js');
    vi.mocked(similarityModule.findDuplicateConcept).mockResolvedValue(null);

    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'] }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('jobId');
  });

  it('returns 202 with seed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['adventure'], seed: 'a brave hero' }),
    });
    expect(res.status).toBe(202);
  });

  it('returns 202 with webhook URL', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['sci-fi'], webhookUrl: 'https://example.com/hook' }),
    });
    expect(res.status).toBe(202);
  });

  it('rejects webhook URL pointing to blocked host', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'], webhookUrl: 'http://localhost:8000/hook' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects excessive seed length', async () => {
    const longSeed = 'x'.repeat(501);
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy'], seed: longSeed }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects multiple genres', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ genre: ['fantasy', 'adventure'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/stories/generate/:storyId/generation-status', () => {
  it('returns 200 for owned story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/generation-status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('state', 'completed');
  });

  it('returns 404 for non-existent story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/00000000-0000-0000-0000-000000000000/generation-status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/stories/generate/:storyId/episodes/:episodeNumber', () => {
  it('returns 200 for owned story episode', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/episodes/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
  });

  it('returns 400 with invalid episode number', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/episodes/99`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/00000000-0000-0000-0000-000000000000/episodes/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/stories/generate/:storyId/episodes/:episodeNumber/scenes/:sceneNumber', () => {
  it('returns 200 for owned story scene', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/episodes/1/scenes/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
  });

  it('returns 400 with invalid params', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/episodes/99/scenes/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/00000000-0000-0000-0000-000000000000/episodes/1/scenes/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/stories/generate/:storyId/regenerate', () => {
  it('returns 200 for owned story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { error?: string; success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
  });

  it('returns 404 for non-existent story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/00000000-0000-0000-0000-000000000000/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/stories/generate/:jobId/full-state', () => {
  it('returns 200 and completed job state with story', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/full-state`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      error?: string;
      success?: boolean;
      data?: { state?: string; story?: { id?: string } | null };
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('state');
    expect(body.data?.story).not.toBeNull();
    expect(body.data?.story?.id).toBe(STORY_ID);
  });

  it('returns 200 for an in-progress job before the story is persisted', async () => {
    const queueModule = await import('../queue/index.js');
    vi.mocked(queueModule.storyQueue.getJob).mockResolvedValueOnce({
      ...mockJob,
      getState: async () => 'active' as const,
      data: { ...mockJob.data, storyId: undefined },
    } as unknown as Awaited<ReturnType<typeof queueModule.storyQueue.getJob>>);

    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/full-state`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      error?: string;
      success?: boolean;
      data?: { state?: string; story?: { id?: string } | null };
    };
    expect(body.success).toBe(true);
    expect(body.data?.state).toBe('active');
    expect(body.data?.story).toBeNull();
  });

  it('returns 403 when the requesting user does not own the job', async () => {
    const queueModule = await import('../queue/index.js');
    vi.mocked(queueModule.storyQueue.getJob).mockResolvedValueOnce({
      ...mockJob,
      data: { ...mockJob.data, userId: 'other-user-id' },
    } as unknown as Awaited<ReturnType<typeof queueModule.storyQueue.getJob>>);

    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/full-state`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(403);
  });

  it('H9: returns 403 for a legacy job with neither userId nor storyId (fail closed)', async () => {
    const queueModule = await import('../queue/index.js');
    vi.mocked(queueModule.storyQueue.getJob).mockResolvedValueOnce({
      ...mockJob,
      getState: async () => 'active' as const,
      data: { ...mockJob.data, userId: undefined, storyId: undefined },
    } as unknown as Awaited<ReturnType<typeof queueModule.storyQueue.getJob>>);

    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/${STORY_ID}/full-state`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(403);
  });
});
