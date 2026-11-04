import { describe, it, expect, afterEach } from 'vitest';

/**
 * Guards for the test-scaled sleep (PERF-BLUEPRINT-SUITE root fix).
 *
 * The scaling exists so retry-heavy unit suites don't sit through real
 * backoff windows. These tests pin the safety properties: production is
 * never scaled, scaling only shrinks, and non-Vitest runtimes ignore the
 * factor entirely.
 */
describe('test-scaled sleep', () => {
  const ORIGINAL = { VITEST: process.env.VITEST, FACTOR: process.env.STORY_TEST_SLEEP_FACTOR };

  afterEach(() => {
    if (ORIGINAL.VITEST === undefined) delete process.env.VITEST;
    else process.env.VITEST = ORIGINAL.VITEST;
    if (ORIGINAL.FACTOR === undefined) delete process.env.STORY_TEST_SLEEP_FACTOR;
    else process.env.STORY_TEST_SLEEP_FACTOR = ORIGINAL.FACTOR;
    vi.resetModules();
  });

  async function loadSleep() {
    const mod = await import('./sleep.js');
    return mod as typeof import('./sleep.js');
  }

  it('scales delays down when running under Vitest with the factor set', async () => {
    process.env.VITEST = 'true';
    process.env.STORY_TEST_SLEEP_FACTOR = '0.01';
    vi.resetModules();
    const { sleep, __getScaledSleepCalls } = await loadSleep();

    const started = Date.now();
    await sleep(1000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500); // 1000ms * 0.01 = 10ms
    expect(__getScaledSleepCalls()).toEqual([10]);
  });

  it('never scales in a non-Vitest runtime even if the variable leaks', async () => {
    delete process.env.VITEST;
    process.env.STORY_TEST_SLEEP_FACTOR = '0.01';
    vi.resetModules();
    const { sleep, __getScaledSleepCalls } = await loadSleep();

    await sleep(20);

    // Unscaled: the recorded delay equals the requested delay (within timer
    // granularity the request itself is what we pin here).
    expect(__getScaledSleepCalls()).toEqual([20]);
  });

  it('clamps the factor to at most 1 (never waits longer than asked)', async () => {
    process.env.VITEST = 'true';
    process.env.STORY_TEST_SLEEP_FACTOR = '5';
    vi.resetModules();
    const { sleep, __getScaledSleepCalls } = await loadSleep();

    await sleep(5);

    expect(__getScaledSleepCalls()).toEqual([5]);
  });

  it('falls back to unscaled when the factor is not a positive finite number', async () => {
    process.env.VITEST = 'true';
    process.env.STORY_TEST_SLEEP_FACTOR = 'not-a-number';
    vi.resetModules();
    const { sleep, __getScaledSleepCalls } = await loadSleep();

    await sleep(3);

    expect(__getScaledSleepCalls()).toEqual([3]);
  });
});
