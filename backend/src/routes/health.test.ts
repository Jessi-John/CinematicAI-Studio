/**
 * Health Check Failure Mode Tests
 *
 * Verifies /api/health correctly reports service degradation.
 *   - DB down → 503
 *   - Redis down → 503
 *   - Both down → 503
 *   - All up → 200
 *
 * Vitest ESM-native mocking: vi.mock() at module level properly intercepts
 * prisma() and getSharedRedis() so we can simulate service failures.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock implementations
const mockPrismaQueryRaw = vi.fn();
const mockRedisPing = vi.fn();

vi.mock('../database/prisma.js', () => ({
  prisma: () => ({
    $queryRaw: mockPrismaQueryRaw,
  }),
}));

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => ({
    ping: mockRedisPing,
  }),
}));

beforeEach(() => {
  mockPrismaQueryRaw.mockReset();
  mockRedisPing.mockReset();
});

describe('GET /api/health — failure modes', () => {
  it('returns 200 with healthy status when DB and Redis are up', async () => {
    mockPrismaQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisPing.mockResolvedValue('PONG');

    const express = (await import('express')).default;
    const { healthRouter } = await import('./health.js');
    const app = express();
    app.use('/api/health', healthRouter);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { status: string; services: { database: string; redis: string } };
      };
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('healthy');
      expect(body.data.services.database).toBe('connected');
      expect(body.data.services.redis).toBe('connected');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns 503 when DB is down (Redis up)', async () => {
    mockPrismaQueryRaw.mockRejectedValue(new Error('DB connection refused'));
    mockRedisPing.mockResolvedValue('PONG');

    const express = (await import('express')).default;
    const { healthRouter } = await import('./health.js');
    const app = express();
    app.use('/api/health', healthRouter);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        success: boolean;
        data: { services: { database: string; redis: string } };
      };
      expect(body.data.services.database).toBe('disconnected');
      expect(body.data.services.redis).toBe('connected');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns 503 when Redis is down (DB up)', async () => {
    mockPrismaQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockRedisPing.mockRejectedValue(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { healthRouter } = await import('./health.js');
    const app = express();
    app.use('/api/health', healthRouter);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        success: boolean;
        data: { services: { database: string; redis: string } };
      };
      expect(body.data.services.database).toBe('connected');
      expect(body.data.services.redis).toBe('disconnected');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns 503 when both DB and Redis are down', async () => {
    mockPrismaQueryRaw.mockRejectedValue(new Error('DB connection refused'));
    mockRedisPing.mockRejectedValue(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { healthRouter } = await import('./health.js');
    const app = express();
    app.use('/api/health', healthRouter);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        success: boolean;
        data: { services: { database: string; redis: string } };
      };
      expect(body.data.services.database).toBe('disconnected');
      expect(body.data.services.redis).toBe('disconnected');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
