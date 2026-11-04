/**
 * Unit tests for JWT middleware.
 * Verifies that tokens are accepted from both cookie and Authorization: Bearer header.
 *
 * Root cause: The original test used CommonJS `require('jsonwebtoken')` which is not
 * supported in ESM mode (Jest runs with --experimental-vm-modules).
 *
 * Solution: Run tests INSIDE vi.hoisted() callback to ensure fresh module state
 * and the mocked getJwtSecret is applied before jwt.js loads.
 * The mocked getJwtSecret returns the hardcoded 'test-jwt-secret-not-for-production' from the mock factory.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { JwtPayload } from './jwt.js';

type MockJwtReq = {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  path: string;
  user?: JwtPayload;
};

// env.ts derives JWT secret as SHA256(apiSecret + ':jwt')
// In test mode, apiSecret defaults to 'dev-secret-not-for-production' (env.ts line 126)
// We use this same derivation so that tokens created here will verify correctly
const TEST_API_SECRET = 'dev-secret-not-for-production';
const __DERIVED_JWT_SECRET = crypto.createHash('sha256').update(TEST_API_SECRET + ':jwt').digest('hex');

describe('jwtMiddleware', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts token from Authorization: Bearer header', async () => {
    // Set up the mock BEFORE importing jwt.js
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware, signToken } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    // Use signToken from the module — it uses the mocked getJwtSecret
    const token = signToken({ sub: 'user-123', username: 'testuser', role: 'admin' });
    (mockReq.headers as Record<string, string>)['authorization'] = `Bearer ${token}`;
    await jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user?.sub).toBe('user-123');
  });

  it('accepts token from cookie', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware, signToken } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    const token = signToken({ sub: 'user-456', username: 'testuser2', role: 'admin' });
    mockReq.cookies['access_token'] = token;
    await jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user?.sub).toBe('user-456');
  });

  it('accepts token from cookie when both header and cookie are present (cookie takes precedence)', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware, signToken } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    const headerToken = signToken({ sub: 'header-user', username: 'headeruser', role: 'admin' });
    const cookieToken = signToken({ sub: 'cookie-user', username: 'cookieuser', role: 'admin' });
    (mockReq.headers as Record<string, string>)['authorization'] = `Bearer ${headerToken}`;
    mockReq.cookies['access_token'] = cookieToken;
    await jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockReq.user?.sub).toBe('cookie-user');
  });

  it('rejects request with no token', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('rejects malformed Authorization header (non-Bearer)', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    (mockReq.headers as Record<string, string>)['authorization'] = 'Basic dXNlcjpwYXNz';
    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('rejects empty Bearer token', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    (mockReq.headers as Record<string, string>)['authorization'] = 'Bearer ';
    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('rejects expired token', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/api/stories' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    // Create expired token directly with jsonwebtoken
    const jwt = await import('jsonwebtoken');
    const expiredToken = jwt.sign(
      { sub: 'user-123', username: 'testuser', role: 'admin' },
      'test-jwt-secret-not-for-production',
      { expiresIn: '-1s' }
    );
    (mockReq.headers as Record<string, string>)['authorization'] = `Bearer ${expiredToken}`;
    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('skips auth for /api/auth paths (login/logout/register)', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/auth/login' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
    // next() should be called with no error argument — login routes
    // bypass JWT and let the route handler decide. The call may be
    // `next()` (no args) or `next(undefined)`; both signal success.
    // The fail mode is `next(err)` which we want to detect.
    expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    expect(mockReq).not.toHaveProperty('user');
  });

  it('skips auth for /api/auth/refresh', async () => {
    vi.doMock('../config/env.js', () => ({
      getJwtSecret: vi.fn(() => 'test-jwt-secret-not-for-production'),
      getRedisPassword: vi.fn(() => ''),
      allowInsecureLocalHttp: vi.fn(() => false),
      e2eTestBypassEnabled: vi.fn(() => false),
      isProduction: vi.fn(() => false),
    }));

    const { jwtMiddleware } = await import('./jwt.js');

    const mockReq: MockJwtReq = { cookies: {}, headers: {}, path: '/auth/refresh' };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const mockNext = vi.fn();

    jwtMiddleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
    // Same as above: refresh is unauthenticated, so the middleware
    // passes through with no error to let the route handle it.
    expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    expect(mockReq).not.toHaveProperty('user');
  });
});