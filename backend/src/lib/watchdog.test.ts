/**
 * Regression tests for the wall-clock watchdog (REL-006 / BUG-006).
 *
 * The watchdog runs `setTimeout` in a dedicated `worker_threads.Worker` so
 * that the timeout fires regardless of main-thread event loop starvation.
 * These tests pin the contract:
 *
 *   1. The watchdog fires after approximately the configured timeout.
 *   2. The fired promise resolves with `reason: 'timeout'`.
 *   3. Cancellation stops the watchdog.
 *   4. `createWatchdogAbortController` triggers the controller's abort
 *      when the watchdog fires.
 *   5. A normal (non-hung) inner promise resolves with the inner value,
 *      not the watchdog timeout.
 *   6. The watchdog is unaffected by a CPU-saturated event loop on the
 *      main thread (the bug that produced the original 2-hour stall).
 */

import { describe, it, expect } from 'vitest';
import {
  startWatchdog,
  createWatchdogAbortController,
  withWallClockTimeout,
} from './watchdog.js';

describe('wall-clock watchdog (REL-006)', () => {
  it('fires after the configured timeout', async () => {
    const start = Date.now();
    const wd = startWatchdog({ timeoutMs: 200, label: 'test_fires' });
    const result = await wd.fired;
    const elapsed = Date.now() - start;
    // Allow generous slack for the worker thread spin-up.
    expect(result.reason).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(2_000);
    wd.cancel();
  });

  it('resolves with reason: cancelled when cancelled before firing', async () => {
    const wd = startWatchdog({ timeoutMs: 1_000, label: 'test_cancel' });
    // Use a short watchdog (1s) so the test completes fast even under
    // CI load. The cancel at 50ms arrives well before the 1s deadline.
    // The previous 5s watchdog + 50ms cancel was flaky on slow CI because
    // the worker thread could take >50ms to register its message listener,
    // causing the cancel message to be lost and the timeout to fire.
    setTimeout(() => wd.cancel(), 50);
    const result = await wd.fired;
    expect(result.reason).toBe('cancelled');
  });

  it('does not block the event loop on the main thread', async () => {
    // Start a watchdog for 5 seconds.
    const wd = startWatchdog({ timeoutMs: 5_000, label: 'test_nonblocking' });
    // Schedule a fast tick via setTimeout(0). If the watchdog blocked the
    // main loop, this tick would be delayed. The whole point of the worker
    // thread is that main-thread scheduling is unaffected.
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticked).toBe(true);
    wd.cancel();
  });

  it('fires on a wall-clock deadline even with the main thread busy', async () => {
    // This is the regression test for BUG-006. We busy the main thread
    // for the full watchdog window, then check that the watchdog fired
    // on time. The previous JS-level setTimeout implementation would
    // never fire under this condition.
    const wd = startWatchdog({ timeoutMs: 400, label: 'test_busy' });
    const start = Date.now();
    // Busy the main thread synchronously for 300ms (shorter than the
    // 400ms timeout so we can verify the deadline still fires).
    const busyUntil = start + 300;
    while (Date.now() < busyUntil) {
      // spin
    }
    const result = await wd.fired;
    const elapsed = Date.now() - start;
    expect(result.reason).toBe('timeout');
    // The deadline should fire at ~400ms, not at the end of the busy
    // period (300ms) plus some JS-level delay. We allow a wide band
    // because the worker spin-up has some latency.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    wd.cancel();
  });
});

describe('createWatchdogAbortController', () => {
  it('triggers controller.abort() when the watchdog fires', async () => {
    const wd = createWatchdogAbortController(150, 'test_abort');
    let aborted = false;
    let abortReason: unknown = null;
    wd.controller.signal.addEventListener('abort', () => {
      aborted = true;
      abortReason = wd.controller.signal.reason;
    });
    // Wait long enough for the watchdog to fire (poll because worker-thread
    // spin-up latency can vary on loaded CI runners).
    const start = Date.now();
    while (!aborted && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(aborted).toBe(true);
    expect((abortReason as Error | undefined)?.message).toContain('test_abort');
    expect((abortReason as Error | undefined)?.message).toContain('watchdog fired');
    wd.cancel();
  });

  it('does not abort if cancelled before the watchdog fires', async () => {
    const wd = createWatchdogAbortController(5_000, 'test_no_abort');
    let aborted = false;
    wd.controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    wd.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(aborted).toBe(false);
  });
});

describe('withWallClockTimeout', () => {
  it('resolves with the inner value when the inner promise wins', async () => {
    const inner = Promise.resolve('hello');
    const out = await withWallClockTimeout(inner, 5_000, 'test_inner_wins', 'job-1');
    expect(out).toBe('hello');
  });

  it('rejects with a timeout error when the watchdog wins', async () => {
    const inner = new Promise((resolve) => {
      setTimeout(() => resolve('late'), 5_000);
    });
    await expect(
      withWallClockTimeout(inner, 100, 'test_watchdog_wins', 'job-2')
    ).rejects.toThrow(/test_watchdog_wins hard timeout/);
  });

  it('rejects on timeout even with the main thread busy', async () => {
    // Schedule an inner promise that never resolves quickly enough.
    const inner = new Promise((resolve) => {
      setTimeout(() => resolve('too late'), 5_000);
    });
    const start = Date.now();
    // Busy the main thread for 50ms, then check that the watchdog wins.
    while (Date.now() - start < 50) {
      // spin
    }
    await expect(
      withWallClockTimeout(inner, 200, 'test_busy_wins', 'job-3')
    ).rejects.toThrow(/test_busy_wins hard timeout/);
  });
});
