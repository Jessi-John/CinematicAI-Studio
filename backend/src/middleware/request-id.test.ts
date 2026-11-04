/**
 * Unit tests for request-id middleware.
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

describe('requestIdMiddleware', () => {
  let mockReq: { headers: Record<string, unknown>; requestId?: string; startTime?: number };
  let mockRes: { setHeader: AnyMock };
  let mockNext: NextFunctionMock;

  beforeEach(() => {
    mockReq = { headers: {} };
    mockRes = { setHeader: vi.fn() };
    mockNext = vi.fn() as unknown as NextFunctionMock;
  });

  async function loadMiddleware() {
    const mod = await import('./request-id.js');
    return mod.requestIdMiddleware;
  }

  it('generates a UUID when no x-request-id header is present', async () => {
    const middleware = await loadMiddleware();
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockReq.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('uses the header value when x-request-id is valid', async () => {
    const middleware = await loadMiddleware();
    mockReq.headers['x-request-id'] = 'valid-request-id-123';
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockReq.requestId).toBe('valid-request-id-123');
  });

  it('generates UUID for invalid x-request-id format', async () => {
    const middleware = await loadMiddleware();
    mockReq.headers['x-request-id'] = 'invalid id with spaces!@#';
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockReq.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('sets X-Request-ID response header', async () => {
    const middleware = await loadMiddleware();
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-Request-ID', mockReq.requestId);
  });

  it('calls next()', async () => {
    const middleware = await loadMiddleware();
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('sets startTime to current timestamp', async () => {
    const middleware = await loadMiddleware();
    const before = Date.now();
    middleware(mockReq as never, mockRes as never, mockNext);
    const after = Date.now();
    expect(mockReq.startTime).toBeGreaterThanOrEqual(before);
    expect(mockReq.startTime).toBeLessThanOrEqual(after);
  });

  it('accepts array header value (uses first element)', async () => {
    const middleware = await loadMiddleware();
    mockReq.headers['x-request-id'] = ['my-request-id', 'second'];
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockReq.requestId).toBe('my-request-id');
  });

  it('rejects header longer than 64 characters', async () => {
    const middleware = await loadMiddleware();
    mockReq.headers['x-request-id'] = 'a'.repeat(65);
    middleware(mockReq as never, mockRes as never, mockNext);
    expect(mockReq.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
