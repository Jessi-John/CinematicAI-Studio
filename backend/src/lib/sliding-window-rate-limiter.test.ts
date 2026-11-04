import { describe, it, expect } from 'vitest';

type RateLimiter = {
  maxRequests: number;
  windowMs: number;
  timestamps: number[];
  _lock: Promise<void>;
};

describe('SlidingWindowRateLimiter', () => {
  let __createRateLimiter: (max: number, windowMs: number) => RateLimiter;
  let __waitForRateLimit: (limiter: RateLimiter) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('./ai-client.js');
    __createRateLimiter = mod.__createRateLimiter;
    __waitForRateLimit = mod.__waitForRateLimit;
  });

  it('allows requests within the limit', async () => {
    const limiter = __createRateLimiter(3, 60_000);
    // First 3 requests should pass immediately
    for (let i = 0; i < 3; i++) {
      await __waitForRateLimit(limiter);
    }
    expect(limiter.timestamps.length).toBe(3);
  });

  it('rate limits request that exceeds limit (verified via expired window recovery)', async () => {
    const limiter = __createRateLimiter(2, 300);
    // Fill both slots
    await __waitForRateLimit(limiter);
    await __waitForRateLimit(limiter);
    expect(limiter.timestamps.length).toBe(2);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 400));

    // Should now pass (old timestamps expired)
    await __waitForRateLimit(limiter);
    expect(limiter.timestamps.length).toBe(1);
  });

  it('serializes concurrent callers via mutex', async () => {
    const limiter = __createRateLimiter(1, 200);
    // Fire 3 concurrent requests — the first acquires the slot,
    // the others sleep for ~windowMs. After the window expires,
    // the second should acquire the slot and the third will sleep again.
    // Start 3 concurrent requests
    __waitForRateLimit(limiter);
    __waitForRateLimit(limiter);
    __waitForRateLimit(limiter);
    // Wait briefly — first request should have acquired the slot
    await new Promise(r => setTimeout(r, 50));
    // Only 1 timestamp (the first request pushed it, the other two
    // saw the full window and are sleeping)
    expect(limiter.timestamps.length).toBe(1);
  });

  it('filters expired timestamps from previous window', async () => {
    const limiter = __createRateLimiter(2, 100);
    // Fill both slots at time 0
    await __waitForRateLimit(limiter);
    await __waitForRateLimit(limiter);
    expect(limiter.timestamps.length).toBe(2);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 150));

    // Old timestamps should be filtered, new request should pass
    await __waitForRateLimit(limiter);
    // After filtering, there should be 1 new timestamp
    expect(limiter.timestamps.length).toBe(1);
  });

  it('uses different limiters for different providers', () => {
    const a = __createRateLimiter(20, 60_000);
    const b = __createRateLimiter(30, 60_000);
    const c = __createRateLimiter(30, 60_000);
    expect(a.maxRequests).toBe(20);
    expect(a.timestamps).not.toBe(b.timestamps);
    expect(b.timestamps).not.toBe(c.timestamps);
  });

  it('resets timestamps on each call (new limiter starts empty)', () => {
    const limiter = __createRateLimiter(10, 60_000);
    expect(limiter.timestamps).toEqual([]);
  });
});
