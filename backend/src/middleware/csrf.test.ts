/**
 * Unit tests for CSRF middleware.
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

describe('csrfMiddleware', () => {
  // Express strips the /api mount prefix from req.path before middleware runs.
  // The CSRF middleware reconstructs the full path via req.baseUrl + req.path
  // (this is the bug fix from the integration test: the pre-fix code used
  // req.path.startsWith('/api') which was always false when mounted at /api).
  // Tests must set baseUrl='/api' and use the mount-relative path.
  let mockReq: { method: string; path: string; baseUrl: string; headers: Record<string, unknown> };
  let mockRes: { status: AnyMock; json: AnyMock };
  let mockNext: NextFunctionMock;

  beforeEach(() => {
    mockReq = {
      method: 'POST',
      baseUrl: '/api',
      path: '/stories/generate',
      headers: {},
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    mockNext = vi.fn() as unknown as NextFunctionMock;
  });

  async function loadCsrfMiddleware() {
    const mod = await import('./csrf.js');
    return mod.csrfMiddleware;
  }

  describe('path exemptions', () => {
    it('skips non-/api paths', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.path = '/health';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('skips GET requests', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'GET';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips HEAD requests', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'HEAD';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips OPTIONS requests', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'OPTIONS';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips /api/health (Express strips /api prefix from path)', async () => {
      // server.ts: app.use('/api', csrfMiddleware) — Express strips /api
      // So req.path seen by middleware is /health, not /api/health
      const middleware = await loadCsrfMiddleware();
      mockReq.path = '/health';
      mockReq.method = 'POST';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips /api/health/something (path seen as /health/deep)', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.path = '/health/deep';
      mockReq.method = 'POST';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips /api/metrics (path seen as /metrics)', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.path = '/metrics';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('skips SSE endpoint', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'GET';
      mockReq.path = '/stories/generate/job-123/events';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('token validation', () => {
    it('returns 403 when X-CSRF-Token header is missing on POST (non-exempt path)', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'POST';
      // baseUrl='/api' + path='/stories/generate' → fullPath='/api/stories/generate'
      // → CSRF check IS applied (non-exempt, mutation method)
      mockReq.path = '/stories/generate';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('X-CSRF-Token header missing') })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 403 when X-CSRF-Token is too short', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.headers['x-csrf-token'] = 'short';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid') })
      );
    });

    it('returns 403 when X-CSRF-Token is too long', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.headers['x-csrf-token'] = 'a'.repeat(65);
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('returns 403 when X-CSRF-Token contains non-hex characters', async () => {
      const middleware = await loadCsrfMiddleware();
      // 64 chars but with invalid chars (g-z)
      mockReq.headers['x-csrf-token'] = 'a'.repeat(48) + 'ghijklmnop'.repeat(1).slice(0, 16);
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('returns 403 when X-CSRF-Token is valid length but invalid chars', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.headers['x-csrf-token'] = 'Z'.repeat(64); // Z is not valid hex
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('accepts valid 64-char lowercase hex token with matching cookie', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.headers['x-csrf-token'] = 'a'.repeat(64);
      mockReq.headers['cookie'] = 'XSRF-TOKEN=' + 'a'.repeat(64);
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('accepts valid 64-char mixed-case hex token with matching cookie', async () => {
      const middleware = await loadCsrfMiddleware();
      const token = 'aAbBcCdDeEfF0123456789'.repeat(3).slice(0, 64);
      mockReq.headers['x-csrf-token'] = token;
      mockReq.headers['cookie'] = 'XSRF-TOKEN=' + token;
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('returns 403 when header value does not match cookie value', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.headers['x-csrf-token'] = 'a'.repeat(64);
      mockReq.headers['cookie'] = 'XSRF-TOKEN=' + 'b'.repeat(64);
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('does not match') })
      );
    });

    it('returns 403 on PATCH without token (non-exempt path)', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'PATCH';
      mockReq.path = '/stories/123';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('returns 403 on DELETE without token (non-exempt path)', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'DELETE';
      mockReq.path = '/stories/123';
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('accepts valid token on DELETE with matching cookie', async () => {
      const middleware = await loadCsrfMiddleware();
      mockReq.method = 'DELETE';
      mockReq.path = '/stories/123';
      mockReq.headers['x-csrf-token'] = 'b'.repeat(64);
      mockReq.headers['cookie'] = 'XSRF-TOKEN=' + 'b'.repeat(64);
      middleware(mockReq as never, mockRes as never, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  });
});

// Pin the canonical CSRF exemption list and mutation-method list as exported
// constants. If anyone adds/removes a path or method here, the tests must
// change too — a tripwire that catches silent drift.
describe('CSRF exported constants', () => {
  it('CSRF_EXEMPT_PATHS contains /health and /metrics only', async () => {
    const { CSRF_EXEMPT_PATHS } = await import('./csrf.js');
    expect(CSRF_EXEMPT_PATHS).toEqual(['/health', '/metrics']);
  });

  it('CSRF_MUTATION_METHODS contains POST, PUT, PATCH, DELETE', async () => {
    const { CSRF_MUTATION_METHODS } = await import('./csrf.js');
    expect(CSRF_MUTATION_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
  });
});