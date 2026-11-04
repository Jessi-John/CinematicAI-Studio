/**
 * Unit tests for API authentication middleware.
 *
 * Tests use static imports. vi.mock is applied at module level.
 * Note: Valid signature tests depend on getApiSecret() being correctly mocked.
 * If the mock is not applied (ESM module caching), those tests may fail.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction } from 'express';
import type { Mock } from 'vitest';

/**
 * A mock function that is also callable as a `NextFunction`.
 * Intersection of `Mock<NextFunction>` (for `.mock.calls` assertions) and
 * `NextFunction` (so the value is directly accepted by middleware).
 */
type NextFunctionMock = Mock<NextFunction> & NextFunction;
type AnyMock = ReturnType<typeof vi.fn>;

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getApiSecret: vi.fn(() => 'test-secret-key-for-testing'),
  getRedisPassword: vi.fn(() => ''),
  allowInsecureLocalHttp: vi.fn(() => false),
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

import { apiAuthMiddleware, verifySSEAuth } from '../middleware/api-auth.js';

describe('apiAuthMiddleware', () => {
  // verifySSEAuth reads req.cookies[JWT_COOKIE] and req.originalUrl.
  // Tests must provide these fields — otherwise the code throws a TypeError on
  // the very first property access (req.cookies[undefined]) and never reaches
  // the assertion.
  let mockReq: { method: string; path: string; baseUrl: string; originalUrl: string; headers: Record<string, unknown>; query: Record<string, unknown>; cookies: Record<string, string>; params: Record<string, string> };
  let mockRes: { status: AnyMock; json: AnyMock };
  let mockNext: NextFunctionMock;

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      baseUrl: '/api',
      path: '/stories',
      originalUrl: '/api/stories',
      headers: {},
      query: {},
      cookies: {},
      params: {},
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    mockNext = vi.fn() as unknown as NextFunctionMock;
  });

  describe('health path exemption', () => {
    it('skips /health', () => {
      mockReq.path = '/health';
      apiAuthMiddleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips /health/deep/path', () => {
      mockReq.path = '/health/deep';
      apiAuthMiddleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('SSE HMAC auth (verifySSEAuth) — error paths', () => {
    it('returns 401 when auth query param is missing', () => {
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { t: String(Date.now()) };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 401 when t query param is missing', () => {
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: 'someauth' };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when t is not a number', () => {
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: 'someauth', t: 'not-a-number' };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when timestamp is expired (> 5 min old)', () => {
      const oldTimestamp = Date.now() - (6 * 60 * 1000);
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: 'someauth', t: String(oldTimestamp) };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when timestamp is too far in the future (> 60s)', () => {
      const futureTimestamp = Date.now() + (120 * 1000);
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: 'someauth', t: String(futureTimestamp) };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when HMAC signature is invalid', () => {
      const timestamp = Date.now();
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: 'a'.repeat(64), t: String(timestamp) };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 401 when query params are arrays (repeated params)', () => {
      const timestamp = Date.now();
      mockReq.originalUrl = '/api/stories/generate/job-123/events';
      mockReq.path = '/stories/generate/job-123/events';
      mockReq.params = { jobId: 'job-123' };
      mockReq.query = { auth: ['a'.repeat(64), 'b'.repeat(64)], t: [String(timestamp), String(timestamp + 1)] };
      verifySSEAuth(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});