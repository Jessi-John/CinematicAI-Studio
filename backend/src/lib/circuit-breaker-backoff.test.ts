import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { CircuitBreaker } from './ai-client.js';

describe('Circuit breaker exponential backoff', () => {
  let __applyExponentialBackoff: (cb: CircuitBreaker) => void;
  let __resetBackoffToBase: (cb: CircuitBreaker) => void;
  let __resetCircuitBreakerForTests: () => void;
  let __setCircuitBreakerHalfOpenForTests: (provider: 'kimi' | 'mistral') => void;
  let areAllProvidersUnavailable: () => boolean;

  beforeAll(async () => {
    const mod = await import('./ai-client.js');
    __applyExponentialBackoff = mod.__applyExponentialBackoff;
    __resetBackoffToBase = mod.__resetBackoffToBase;
    __resetCircuitBreakerForTests = mod.__resetCircuitBreakerForTests;
    __setCircuitBreakerHalfOpenForTests = mod.__setCircuitBreakerHalfOpenForTests;
    areAllProvidersUnavailable = mod.areAllProvidersUnavailable;
  });

  beforeEach(() => {
    __resetCircuitBreakerForTests();
  });

  describe('__applyExponentialBackoff', () => {
    it('doubles the reset timeout', () => {
      const cb = { resetTimeout: 60000, maxResetTimeout: 1800000 };
      __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(120000);
    });

    it('doubles repeatedly on multiple calls', () => {
      const cb = { resetTimeout: 60000, maxResetTimeout: 1800000 };
      __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(120000);
      __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(240000);
      __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(480000);
    });

    it('caps at maxResetTimeout', () => {
      const cb = { resetTimeout: 1800000, maxResetTimeout: 1800000 };
      __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(1800000);
    });

    it('never exceeds maxResetTimeout even after many doublings', () => {
      const cb = { resetTimeout: 1, maxResetTimeout: 1800000 };
      for (let i = 0; i < 100; i++) {
        __applyExponentialBackoff(cb as unknown as CircuitBreaker);
      }
      expect(cb.resetTimeout).toBe(1800000);
    });
  });

  describe('__resetBackoffToBase', () => {
    it('restores baseResetTimeout after backoff', () => {
      const cb = { resetTimeout: 480000, baseResetTimeout: 60000, maxResetTimeout: 1800000 };
      __resetBackoffToBase(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(60000);
    });

    it('works even when resetTimeout equals baseResetTimeout', () => {
      const cb = { resetTimeout: 60000, baseResetTimeout: 60000, maxResetTimeout: 1800000 };
      __resetBackoffToBase(cb as unknown as CircuitBreaker);
      expect(cb.resetTimeout).toBe(60000);
    });
  });

  describe('__resetCircuitBreakerForTests', () => {
    it('resets both circuit breakers to closed state', () => {
      // Before reset, use real breaker state
      __setCircuitBreakerHalfOpenForTests('mistral');
      __resetCircuitBreakerForTests();
      // All providers should be available after reset
      expect(areAllProvidersUnavailable()).toBe(false);
    });
  });

  describe('areAllProvidersUnavailable', () => {
    it('returns false when all breakers are closed', () => {
      __resetCircuitBreakerForTests();
      expect(areAllProvidersUnavailable()).toBe(false);
    });

    it('returns false when any breaker is half-open (probing)', () => {
      __resetCircuitBreakerForTests();
      __setCircuitBreakerHalfOpenForTests('mistral');
      expect(areAllProvidersUnavailable()).toBe(false);
    });
  });

  describe('H3 — half-open probe lock is released after unrecorded throws', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('pipeline abort during a half-open probe does not wedge the provider', async () => {
      const mod = await import('./ai-client.js');
      mod.__resetCircuitBreakerForTests();
      mod.__setCircuitBreakerHalfOpenForTests('mistral');

      const ac = new AbortController();
      // Abort from INSIDE the fetch call: the probe has already been acquired,
      // so the next attempt's checkPipelineAborted() throws while the probe
      // lock is held — the exact path that previously stranded it forever.
      globalThis.fetch = vi.fn(() => {
        ac.abort();
        return Promise.reject(new Error('network down')) as Promise<never>;
      }) as unknown as typeof fetch;

      await expect(
        mod.runWithAIPipelineContext('h3-test', ac.signal, () =>
          mod.generateWithMistral('system', 'user')
        )
      ).rejects.toThrow(/Pipeline aborted/);

      // H3 invariant: the probe lock is freed and the circuit re-opened with
      // backoff — a future probe may proceed after the reset timeout instead
      // of wedging on "probe already in flight" until process restart.
      const { mistralCircuitBreaker } = mod.__getBreakersForTests();
      expect(mistralCircuitBreaker.halfOpenProbeLock).toBeNull();
      expect(mistralCircuitBreaker.state).toBe('open');
    }, 20000);

    it('stale probe lock is force-released after the TTL', async () => {
      const mod = await import('./ai-client.js');
      mod.__resetCircuitBreakerForTests();
      mod.__setCircuitBreakerHalfOpenForTests('mistral');

      // Simulate a probe that acquired the lock and hung forever (never settles).
      globalThis.fetch = vi.fn(() => new Promise(() => {}) as Promise<Response>) as unknown as typeof fetch;
      const pending = mod.generateWithMistral('system', 'user');
      pending.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));

      // The lock is held by the hung probe.
      const { mistralCircuitBreaker } = mod.__getBreakersForTests();
      expect(mistralCircuitBreaker.halfOpenProbeLock).not.toBeNull();

      // Age the lock past the TTL and pin lastFailure to now, so the next call
      // force-releases the stale lock and then fails fast on the open breaker
      // (no half-open re-probe, no provider fallback hang).
      globalThis.fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
      mistralCircuitBreaker.halfOpenProbeLockedAt = Date.now() - 10 * 60 * 1000;
      mistralCircuitBreaker.lastFailure = Date.now();

      let message = '';
      try {
        await mod.generateWithMistral('system', 'user');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toMatch(/probe already in flight/);
      // The stale lock was force-released (and the failed call re-opened the breaker).
      expect(mistralCircuitBreaker.halfOpenProbeLock).toBeNull();
      expect(mistralCircuitBreaker.state).toBe('open');
    }, 20000);
  });
});
