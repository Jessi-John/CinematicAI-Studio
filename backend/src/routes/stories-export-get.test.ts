/**
 * Regression tests for GET /api/stories/export in stories.ts.
 *
 * Verifies that the bulk-export endpoint fails closed when the request is not
 * authenticated, preventing a route or middleware misconfiguration from
 * exposing every story in the system.
 */

import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';
import { getAllStories } from '../database/prisma-storage.js';

vi.mock('../middleware/rate-limit.js', () => ({
  storiesLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../database/prisma-storage.js', () => ({
  getAllStories: vi.fn(),
}));

describe('GET /api/stories/export ownership guard', () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;
  let requestUser: { sub: string; role: string } | undefined;

  beforeAll(async () => {
    const { storiesRouter } = await import('./stories.js');
    app = express();
    app.use(express.json());
    app.use('/api/stories', (req, _res, next) => {
      if (requestUser) {
        (req as unknown as Record<string, unknown>).user = requestUser;
      }
      next();
    }, storiesRouter);

    server = app.listen(0);
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
  });

  beforeEach(() => {
    requestUser = { sub: 'user-1', role: 'user' };
    vi.mocked(getAllStories).mockReset();
  });

  async function getExport(): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/stories/export`);
  }

  it('returns 401 when the request is not authenticated', async () => {
    requestUser = undefined;
    const res = await getExport();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Unauthorized');
    expect(getAllStories).not.toHaveBeenCalled();
  });

  it('returns 200 and filters by the authenticated user', async () => {
    vi.mocked(getAllStories).mockResolvedValue({
      stories: [],
      total: 0,
      hasMore: false,
    });
    const res = await getExport();
    expect(res.status).toBe(200);
    expect(getAllStories).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });
});
