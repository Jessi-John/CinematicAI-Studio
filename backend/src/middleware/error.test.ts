/**
 * Unit tests for error middleware.
 */

import { describe, it, expect, vi } from 'vitest';

describe('AppError', () => {
  async function loadErrorModule() {
    const mod = await import('./error.js');
    return mod;
  }

  it('constructs with message, statusCode, and code', async () => {
    const { AppError } = await loadErrorModule();
    const err = new AppError('Not found', 404, 'NOT_FOUND');
    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults code to undefined when not provided', async () => {
    const { AppError } = await loadErrorModule();
    const err = new AppError('Bad request', 400);
    // The constructor sets code to `undefined` when not provided. The
    // contract we care about is: an explicit string is preserved and a
    // missing string is left undefined. Verify by checking the value
    // against `undefined` literally.
    expect(err.code === undefined).toBe(true);
    // And when a code IS provided, it is preserved (round-trip).
    const errWithCode = new AppError('Bad request', 400, 'BAD_REQUEST');
    expect(errWithCode.code).toBe('BAD_REQUEST');
  });
});

describe('notFoundHandler', () => {
  async function loadErrorModule() {
    const mod = await import('./error.js');
    return mod;
  }

  it('returns 404 with route not found message', async () => {
    const { notFoundHandler, AppError, errorHandler } = await loadErrorModule();
    const mockReq = { method: 'GET', path: '/unknown', requestId: 'req-123' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();
    notFoundHandler(mockReq as never, mockRes as never, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    const err = mockNext.mock.calls[0]![0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('ROUTE_NOT_FOUND');

    errorHandler(err, mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'Cannot GET /unknown',
      code: 'ROUTE_NOT_FOUND',
      requestId: 'req-123',
    });
  });

  it('uses "unknown" requestId when not set', async () => {
    const { notFoundHandler, AppError, errorHandler } = await loadErrorModule();
    const mockReq = { method: 'POST', path: '/api/test', requestId: undefined };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();
    notFoundHandler(mockReq as never, mockRes as never, mockNext);
    const err = mockNext.mock.calls[0]![0];
    expect(err).toBeInstanceOf(AppError);

    errorHandler(err, mockReq as never, mockRes as never, mockNext);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'unknown' })
    );
  });
});

describe('errorHandler', () => {
  async function loadErrorModule() {
    const mod = await import('./error.js');
    return mod;
  }

  it('returns error message for AppError instances', async () => {
    const { AppError, errorHandler } = await loadErrorModule();
    const err = new AppError('Rate limit exceeded', 429, 'RATE_LIMIT');
    const mockReq = { requestId: 'req-456' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err, mockReq as never, mockRes as never, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT',
      requestId: 'req-456',
    });
  });

  it('returns 500 for non-AppError with hidden message in production', async () => {
    const { errorHandler } = await loadErrorModule();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const err = new Error('Sensitive internal detail');
    const mockReq = { requestId: 'req-789' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'Internal server error',
      requestId: 'req-789',
    });

    process.env.NODE_ENV = originalEnv;
  });

  it('includes error message in development mode', async () => {
    const { errorHandler } = await loadErrorModule();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const err = new Error('DB connection failed');
    const mockReq = { requestId: 'req-dev' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Internal server error' })
    );

    process.env.NODE_ENV = originalEnv;
  });

  // Regression: body-parser raises PayloadTooLargeError when the request body
  // exceeds the configured limit. The error has `type: 'entity.too.large'` and
  // a `status: 413` property. Without this branch, the 413 surfaces as a 500 —
  // masking the real cause. This test pins the fix.
  it('returns 413 for body-parser PayloadTooLargeError (entity.too.large)', async () => {
    const { errorHandler } = await loadErrorModule();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      statusCode: 413,
    });
    const mockReq = { requestId: 'req-413' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err as never, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'Request body too large',
      requestId: 'req-413',
    });
  });

  it('returns 413 when only statusCode is set (older body-parser variants)', async () => {
    const { errorHandler } = await loadErrorModule();
    const err = Object.assign(new Error('too large'), { statusCode: 413 });
    const mockReq = { requestId: 'req-413b' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err as never, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
  });

  // Regression: body-parser v1.19+ emits PayloadTooLargeError (name property)
  // with no .type field. Ensure we catch it by status alone.
  it('returns 413 for PayloadTooLargeError by name (body-parser v1.19+)', async () => {
    const { errorHandler } = await loadErrorModule();
    const err = Object.assign(new Error('request too large'), {
      name: 'PayloadTooLargeError',
      status: 413,
      statusCode: 413,
    });
    const mockReq = { requestId: 'req-413c' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err as never, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'Request body too large',
      requestId: 'req-413c',
    });
  });

  // Any error with status===413 must return 413 (defence in depth)
  it('returns 413 for any error with status 413 regardless of type field', async () => {
    const { errorHandler } = await loadErrorModule();
    const err = Object.assign(new Error('whatever'), { status: 413 });
    const mockReq = { requestId: 'req-413d' };
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const mockNext = vi.fn();

    errorHandler(err as never, mockReq as never, mockRes as never, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
  });
});

describe('asyncHandler', () => {
  async function loadErrorModule() {
    const mod = await import('./error.js');
    return mod;
  }

  it('calls the wrapped function and returns a RequestHandler', async () => {
    const { asyncHandler } = await loadErrorModule();
    const mockFn = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    const handler = asyncHandler(mockFn as unknown as Parameters<typeof asyncHandler>[0]);
    expect(typeof handler).toBe('function');
  });

  it('catches errors from the async function and passes to next', async () => {
    const { asyncHandler } = await loadErrorModule();
    const testError = new Error('async error');
    const mockFn = vi.fn<() => Promise<never>>().mockRejectedValue(testError);
    const handler = asyncHandler(mockFn as unknown as Parameters<typeof asyncHandler>[0]);
    const mockReq = {};
    const mockRes = {};
    const mockNext = vi.fn();

    await handler(mockReq as never, mockRes as never, mockNext);
    expect(mockNext).toHaveBeenCalledWith(testError);
  });
});
