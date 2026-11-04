import { vi } from 'vitest';
import { isRetriableStatus, isRetriableError, calculateDelay } from './retry.js';

describe('retry utilities', () => {
  describe('isRetriableStatus', () => {
    it('returns true for 429', () => {
      expect(isRetriableStatus(429)).toBe(true);
    });
    it('returns true for 500', () => {
      expect(isRetriableStatus(500)).toBe(true);
    });
    it('returns true for 502', () => {
      expect(isRetriableStatus(502)).toBe(true);
    });
    it('returns true for 503', () => {
      expect(isRetriableStatus(503)).toBe(true);
    });
    it('returns true for 504', () => {
      expect(isRetriableStatus(504)).toBe(true);
    });
    it('returns true for 511', () => {
      expect(isRetriableStatus(511)).toBe(true);
    });
    it('returns false for 400', () => {
      expect(isRetriableStatus(400)).toBe(false);
    });
    it('returns false for 401', () => {
      expect(isRetriableStatus(401)).toBe(false);
    });
    it('returns false for 404', () => {
      expect(isRetriableStatus(404)).toBe(false);
    });
    it('returns false for 200', () => {
      expect(isRetriableStatus(200)).toBe(false);
    });
  });

  describe('isRetriableError', () => {
    it('returns true for errors containing "network"', () => {
      expect(isRetriableError(new Error('network error'))).toBe(true);
      expect(isRetriableError(new Error('Failed to connect: network unreachable'))).toBe(true);
    });
    it('returns true for timeout errors', () => {
      expect(isRetriableError(new Error('timeout of 45000ms exceeded'))).toBe(true);
    });
    it('returns true for ECONNRESET', () => {
      expect(isRetriableError(new Error('ECONNRESET'))).toBe(true);
    });
    it('returns true for ENOTFOUND', () => {
      expect(isRetriableError(new Error('ENOTFOUND'))).toBe(true);
    });
    it('returns true for ECONNREFUSED', () => {
      expect(isRetriableError(new Error('ECONNREFUSED'))).toBe(true);
    });
    it('returns true for aborted errors', () => {
      expect(isRetriableError(new Error('Request aborted'))).toBe(true);
    });
    it('returns false for unrelated errors', () => {
      expect(isRetriableError(new Error('Something else'))).toBe(false);
    });
    it('returns false for non-Error inputs', () => {
      expect(isRetriableError('string error')).toBe(false);
      expect(isRetriableError(null)).toBe(false);
      expect(isRetriableError(undefined)).toBe(false);
    });
  });

  describe('calculateDelay', () => {
    it('applies exponential backoff', () => {
      const base = 1000;
      // Mock random to deterministic 0.75 so delays are predictable:
      // attempt 0: max(1000, 1000) * (0.5 + 0.75) = 1000 * 1.25 = 1250
      // attempt 1: max(1000, 2000) * (0.5 + 0.75) = 2000 * 1.25 = 2500
      // attempt 2: max(1000, 4000) * (0.5 + 0.75) = 4000 * 1.25 = 5000
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.75);
      const delay0 = calculateDelay(base, 0);
      const delay1 = calculateDelay(base, 1);
      const delay2 = calculateDelay(base, 2);
      expect(delay0).toBe(1250);
      expect(delay1).toBe(2500);
      expect(delay2).toBe(5000);
      expect(delay1).toBeGreaterThan(delay0);
      expect(delay2).toBeGreaterThan(delay1);
      randomSpy.mockRestore();
    });
    it('caps delay at capMs (default 30000)', () => {
      const delay = calculateDelay(10000, 10); // would be huge without cap
      expect(delay).toBeLessThanOrEqual(30000);
    });
    it('respects custom capMs', () => {
      const delay = calculateDelay(10000, 5, 5000);
      expect(delay).toBeLessThanOrEqual(5000);
    });
    it('adds jitter (result varies each call)', () => {
      const results = new Set();
      for (let i = 0; i < 20; i++) {
        results.add(calculateDelay(1000, 0));
      }
      // With jitter, we expect some variation
      expect(results.size).toBeGreaterThan(1);
    });
  });
});
