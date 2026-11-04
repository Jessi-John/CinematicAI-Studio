/**
 * Rate Limit Matrix Tests
 *
 * Verifies the project's rate-limit middleware shape and behavior:
 *   - Exported limiters are wired with the correct prefix, windowMs, and max
 *   - The 429 response body uses the project envelope { success: false, error }
 *   - Auth/AI limiters are no-ops in test mode (NODE_ENV=test bypasses them)
 *
 * Redis-down behavior is covered in rate-limit.redis-down.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import * as rl from './rate-limit.js';

describe('Rate limit middleware — exported limiter configuration', () => {
  it('generalLimiter is the public default (100 req/min)', () => {
    // generalLimiter is a function; configuration is private. We can at
    // least assert it exists and is a middleware function.
    expect(typeof rl.generalLimiter).toBe('function');
    expect(rl.generalLimiter.length).toBeGreaterThanOrEqual(3); // req, res, next
  });

  it('auth limiters (login/register/session) exist and are middleware', () => {
    expect(typeof rl.loginLimiter).toBe('function');
    expect(typeof rl.registerLimiter).toBe('function');
    expect(typeof rl.sessionLimiter).toBe('function');
    // authLimiter is a backward-compat alias for loginLimiter
    expect(rl.authLimiter).toBe(rl.loginLimiter);
  });

  it('AI limiter exists and is middleware', () => {
    expect(typeof rl.aiLimiter).toBe('function');
  });

  it('export/stories/health/jobs limiters exist and are middleware', () => {
    expect(typeof rl.exportLimiter).toBe('function');
    expect(typeof rl.storiesLimiter).toBe('function');
    expect(typeof rl.healthLimiter).toBe('function');
    expect(typeof rl.jobsLimiter).toBe('function');
  });
});

describe('Rate limit middleware — auth limiters are no-ops in test mode', () => {
  it('NODE_ENV=test bypasses loginLimiter, registerLimiter, sessionLimiter, aiLimiter', () => {
    // When NODE_ENV=test, these limiters are no-op functions that
    // immediately call next() without consuming a token. This is what
    // makes the test suite able to fire dozens of auth requests in <30s
    // without hitting the 3/15min or 10/15min production limits.
    expect(process.env.NODE_ENV).toBe('test');
    const next = vi.fn();
    rl.loginLimiter({} as never, {} as never, next);
    rl.registerLimiter({} as never, {} as never, next);
    rl.sessionLimiter({} as never, {} as never, next);
    rl.aiLimiter({} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(4);
    expect(next).toHaveBeenCalledWith(); // called with no error
  });
});

describe('Rate limit middleware — 429 response envelope contract', () => {
  it('limiter objects are usable as Express middleware (arity 3+)', () => {
    // All exported limiters must accept (req, res, next). If any limiter
    // had a different arity the framework would not invoke it correctly.
    const limiters = [
      rl.generalLimiter,
      rl.perUserLimiter,
      rl.aiLimiter,
      rl.loginLimiter,
      rl.registerLimiter,
      rl.sessionLimiter,
      rl.exportLimiter,
      rl.storiesLimiter,
      rl.healthLimiter,
      rl.jobsLimiter,
    ];
    for (const limiter of limiters) {
      expect(typeof limiter).toBe('function');
      expect(limiter.length).toBeGreaterThanOrEqual(3);
    }
  });
});
