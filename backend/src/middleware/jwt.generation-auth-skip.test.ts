/**
 * Regression tests for REL-011: jwtMiddleware must let generation auth paths
 * through so events.ts can validate HMAC signatures.
 *
 * Without this skip, HMAC-signed GET /api/stories/generate/:jobId/status and
 * /api/stories/generate/:jobId/refresh-auth requests would 401 in jwtMiddleware
 * before reaching eventsRouter, because jwtMiddleware runs at /api before the
 * route-specific HMAC check.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { allowInsecureLocalHttp } from '../config/env.js';

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
  getRedisPassword: vi.fn(() => ''),
  allowInsecureLocalHttp: vi.fn(() => false),
  e2eTestBypassEnabled: vi.fn(() => false),
  isProduction: vi.fn(() => false),
  isRegistrationDisabled: vi.fn(() => false),
  getInviteCode: vi.fn(() => undefined),
  getMaxConcurrentGenerations: vi.fn(() => 0),
  getMaxStoriesPerDay: vi.fn(() => 0),
  getDailySpendCapUsd: vi.fn(() => 0),
  getMonthlySpendCapUsd: vi.fn(() => 0),
  getBackupS3Bucket: vi.fn(() => undefined),
  getBackupS3Prefix: vi.fn(() => 'cinematicai-backups'),
  getAlertWebhookUrl: vi.fn(() => undefined),
}));

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: vi.fn(() => ({
    exists: vi.fn().mockResolvedValue(0),
  })),
}));

const mockReq = (
  overrides: Partial<Request> & { originalUrl: string }
): Request =>
  ({
    cookies: {},
    headers: {},
    path: '/',
    query: {},
    ...overrides,
  }) as unknown as Request;

const mockRes = (): Response =>
  ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }) as unknown as Response;

const mockNext = (): NextFunction => vi.fn();

describe('jwtMiddleware generation auth path skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips auth for /api/stories/generate/:jobId/events (HMAC-only SSE)', async () => {
    const { jwtMiddleware } = await import('./jwt.js');
    const req = mockReq({ originalUrl: '/api/stories/generate/job-123/events' });
    const res = mockRes();
    const next = mockNext();
    await jwtMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips auth for /api/stories/generate/:jobId/status when HMAC params are present', async () => {
    const { jwtMiddleware } = await import('./jwt.js');
    const req = mockReq({
      originalUrl: '/api/stories/generate/job-123/status?auth=abc&t=123',
      query: { auth: 'abc', t: '123' },
    });
    const res = mockRes();
    const next = mockNext();
    await jwtMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips auth for /api/stories/generate/:jobId/refresh-auth when HMAC params are present', async () => {
    const { jwtMiddleware } = await import('./jwt.js');
    const req = mockReq({
      originalUrl: '/api/stories/generate/job-123/refresh-auth?auth=abc&t=123',
      query: { auth: 'abc', t: '123' },
    });
    const res = mockRes();
    const next = mockNext();
    await jwtMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does NOT skip /status without HMAC params (requires JWT)', async () => {
    const { jwtMiddleware } = await import('./jwt.js');
    const req = mockReq({
      originalUrl: '/api/stories/generate/job-123/status',
      query: {},
    });
    const res = mockRes();
    const next = mockNext();
    await jwtMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('strips query string before matching status path', async () => {
    const { jwtMiddleware } = await import('./jwt.js');
    const req = mockReq({
      originalUrl: '/api/stories/generate/job-123/status?other=value',
      query: { other: 'value' },
    });
    const res = mockRes();
    const next = mockNext();
    await jwtMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ALLOW_INSECURE_LOCAL_HTTP=true bypasses production HTTPS enforcement', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.mocked(allowInsecureLocalHttp).mockReturnValue(true);

    const { jwtMiddleware, signToken } = await import('./jwt.js');
    const token = signToken({ sub: 'user-123', username: 'testuser', role: 'admin' });
    const req = mockReq({
      originalUrl: '/api/stories',
      secure: false,
      headers: {},
    });
    (req.headers as Record<string, string>)['authorization'] = `Bearer ${token}`;
    const res = mockRes();
    const next = mockNext();

    await jwtMiddleware(req, res, next);

    process.env.NODE_ENV = originalNodeEnv;
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
