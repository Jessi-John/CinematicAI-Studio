/**
 * Test-scaled sleep.
 *
 * Root-cause fix for slow retry-heavy unit suites (the blueprint tests spent
 * ~52s mostly waiting on real `sleep(RETRY_DELAY_MS * 2^attempt)` backoff
 * windows). The scaling factor is environment-driven at CALL time, not import
 * time, so test setup (e.g. STORY_TEST_MODE in src/test/setup.ts) can set it
 * before the first sleep runs.
 *
 * Safety properties:
 *  - Default factor is 1: production behavior is bit-for-bit unchanged.
 *  - Scaling only ever SHRINKS delays (factor is clamped to (0, 1]), so a
 *    mis-set variable can never make production wait longer than asked.
 *  - Only Vitest runners (the `VITEST` env var) may enable scaling; every
 *    other runtime ignores it. A stray variable in prod is inert.
 *  - Timing assertions that depend on real elapsed time should stub this
 *    module (vi.mock('./sleep.js')) rather than fight the factor.
 */

const sleepCalls: Array<number> = [];

export function sleep(ms: number): Promise<void> {
  const factor = getSleepFactor();
  const scaled = Math.max(0, Math.round(ms * factor));
  sleepCalls.push(scaled);
  return new Promise((resolve) => setTimeout(resolve, scaled));
}

/** Scaled durations actually slept, for assertions in this module's tests. */
export function __getScaledSleepCalls(): Array<number> {
  return [...sleepCalls];
}

function getSleepFactor(): number {
  if (process.env.VITEST !== 'true') return 1;
  const raw = process.env.GSTACK_TEST_SLEEP_FACTOR ?? process.env.STORY_TEST_SLEEP_FACTOR;
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 1);
}
