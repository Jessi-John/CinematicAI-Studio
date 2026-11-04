/**
 * Regression tests for generation quota enforcement.
 */

import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';
import { storyQueue } from '../queue/index.js';
import { prisma } from '../database/prisma.js';

vi.mock('../queue/index.js', () => ({
  addStoryJob: vi.fn().mockResolvedValue({ id: 'job-123' }),
  storyQueue: {
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0 }),
  },
}));

vi.mock('../database/prisma.js', () => ({
  prisma: vi.fn(),
}));

vi.mock('../lib/copyright-filter.js', () => ({
  checkText: vi.fn().mockReturnValue({ clean: true, hits: [] }),
}));

vi.mock('../services/similarity.js', () => ({
  findDuplicateConcept: vi.fn().mockResolvedValue(null),
  SEMANTIC_DUP_THRESHOLD: 0.85,
  LEXICAL_HARD_BLOCK: 0.95,
}));

describe('generation quota enforcement', () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    vi.mocked(prisma).mockReturnValue({
      story: {
        count: vi.fn().mockResolvedValue(0),
      },
    } as never);

    const { generationRouter } = await import('./generation.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).user = { sub: 'user-1', username: 'user', role: 'user' };
      next();
    });
    app.use('/api/stories/generate', generationRouter);

    server = app.listen(0);
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    delete process.env.MAX_CONCURRENT_GENERATIONS;
    delete process.env.MAX_STORIES_PER_DAY;
  });

  beforeEach(() => {
    delete process.env.MAX_CONCURRENT_GENERATIONS;
    delete process.env.MAX_STORIES_PER_DAY;
    vi.clearAllMocks();
  });

  async function generate(): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/stories/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genre: ['fantasy'] }),
    });
  }

  it('rejects when concurrent generation limit is reached', async () => {
    process.env.MAX_CONCURRENT_GENERATIONS = '1';
    vi.mocked(storyQueue.getJobCounts).mockResolvedValue({ waiting: 1, active: 0, delayed: 0 });
    const res = await generate();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Too many concurrent generations');
  });

  it('rejects when daily story limit is reached', async () => {
    process.env.MAX_STORIES_PER_DAY = '5';
    vi.mocked(prisma().story.count).mockResolvedValue(5);
    const res = await generate();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('Daily story limit reached');
  });

  it('allows generation when under quota', async () => {
    process.env.MAX_CONCURRENT_GENERATIONS = '2';
    process.env.MAX_STORIES_PER_DAY = '10';
    vi.mocked(storyQueue.getJobCounts).mockResolvedValue({ waiting: 0, active: 1, delayed: 0 });
    vi.mocked(prisma().story.count).mockResolvedValue(3);
    const res = await generate();
    expect(res.status).toBe(202);
  });
});
