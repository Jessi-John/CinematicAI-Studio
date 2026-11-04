/**
 * Token Budget Race Condition Tests (E2E)
 *
 * Verifies that the atomic Redis Lua check-and-use script correctly
 * serializes concurrent budget requests. Multiple workers calling
 * checkAndRecordTokenBudget at the exact same time must never collectively
 * exceed the daily/monthly limits — only N calls succeed, where N is the
 * number that fit within budget.
 *
 * This test requires a real Redis instance with Lua scripting support.
 * It runs against the actual Docker Redis container.
 *
 * Run:
 *   docker-compose up -d
 *   npx playwright test e2e/token-budget-race.integration.spec.ts
 */

import { test, expect } from '@playwright/test';
// C2 — ioredis is a devDependency in the root package.json, so the
// standard ESM import resolves correctly from the project root.
import Redis from 'ioredis';
// When running from host, the Docker internal hostname "redis" is not
// resolvable. The .env file sets REDIS_URL=redis://...@redis:6379, but
// from the host we need localhost:6379. Prefer the SAME secret file the
// containers use (secrets/redis_url) so the harness can never drift out of
// sync with the deployment (LIVE-2: .env's local_dev password and secrets/
// were out of sync, silently skipping this entire suite).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveRedisUrl(): string {
  try {
    const secretPath = resolve(__dirname, '..', 'secrets', 'redis_url');
    if (existsSync(secretPath)) {
      const fromSecret = readFileSync(secretPath, 'utf8').trim();
      if (fromSecret) {
        return fromSecret
          .replace(/@redis:/, '@localhost:')
          .replace(/redis:6379/, 'localhost:6379');
      }
    }
  } catch {
    // fall through to env
  }
  const raw = process.env.REDIS_URL || 'redis://localhost:6379';
  if (raw.includes('@redis:') || raw.endsWith('redis:6379')) {
    return raw.replace(/@redis:/, '@localhost:').replace(/redis:6379/, 'localhost:6379');
  }
  return raw;
}

const REDIS_URL = resolveRedisUrl();

test.describe('Token Budget Race Conditions', () => {
  // Verify Redis is available at the suite level
  test.beforeAll(async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 15000 });
    try {
      await redis.ping();
    } catch {
      test.skip(true, 'Redis is not reachable; skipping token-budget race tests');
    } finally {
      await redis.quit();
    }
  });

  test('concurrent Redis Lua EVAL correctly serializes token deductions', async () => {
    // This test directly exercises the Redis Lua script to verify atomicity.
    // The actual checkAndRecordTokenBudget function uses a Lua script that:
    //   1. Gets current daily/monthly budget
    //   2. Checks if deduction would exceed limit
    //   3. If not, decrements and returns success
    //   4. All atomically via Lua EVAL
    //
    // We simulate 20 concurrent workers each trying to deduct 100 tokens
    // from a budget of 1000. Only 10 should succeed.

    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

    // Reset budget to known state — use unique keys per test run to avoid
    // interference from other test processes or real workers running concurrently.
    // Declared outside try so cleanup in finally can reference them.
    const TEST_SUFFIX = `test-${Date.now()}`;
    const DAILY_KEY = `token-budget:daily:${TEST_SUFFIX}`;
    const MONTHLY_KEY = `token-budget:monthly:${TEST_SUFFIX}`;
    const DEDUCT_AMOUNT = 100;
    const CONCURRENT_REQUESTS = 20;

    try {
      // H20: production script INCREMENTS counters from empty toward limits
      // (no pre-seeding — the old test pre-seeded balances for its DECRBY toy).
      // H20: Use the PRODUCTION script (imported from the backend source),
      // not a hand-written approximation. The previous inline Lua (2 keys,
      // DECRBY, 1/0/-1) differed in keys, arithmetic, arity, and return
      // contract from the real ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN — if the
      // production script were regressed to non-atomic GET+INCRBY, that test
      // stayed green. Invocation mirrors checkAndRecordTokenBudget exactly:
      // eval(script, 4, dKey, mKey, promptSubKey, completionSubKey,
      //            dailyLimit, monthlyLimit, amount, prompt, completion).
      const { ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN_SCRIPT } = await import(
        '../backend/src/services/token-budget.js'
      );

      const DAILY_LIMIT = 1000;
      const MONTHLY_LIMIT = 10000;
      const PROMPT_SUB_KEY = `${DAILY_KEY}:prompt`;
      const COMPLETION_SUB_KEY = `${DAILY_KEY}:completion`;

      // Run 20 concurrent charge attempts of 100 tokens each against the
      // daily limit of 1000 — exactly 10 must succeed.
      const promises = Array(CONCURRENT_REQUESTS).fill(null).map((_, i) =>
        redis.eval(
          ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN_SCRIPT,
          4,
          DAILY_KEY,
          MONTHLY_KEY,
          PROMPT_SUB_KEY,
          COMPLETION_SUB_KEY,
          DAILY_LIMIT,
          MONTHLY_LIMIT,
          DEDUCT_AMOUNT,
          60 + (i % 40),
          40 - (i % 40)
        ) as Promise<[number, number, number, string]>
      );

      const results = await Promise.all(promises);

      const successes = results.filter((r) => r[0] === 1).length;
      const dailyRejections = results.filter((r) => r[3] === 'daily exceeded').length;
      const monthlyRejections = results.filter((r) => r[3] === 'monthly exceeded').length;

      // Exactly 10 requests should have succeeded (1000 / 100)
      expect(successes).toBe(10);
      expect(dailyRejections).toBe(10);
      expect(monthlyRejections).toBe(0);

      // Final budget: daily=1000 (limit hit exactly), monthly=1000
      const finalDaily = await redis.get(DAILY_KEY);
      const finalMonthly = await redis.get(MONTHLY_KEY);
      expect(Number(finalDaily)).toBe(1000);
      expect(Number(finalMonthly)).toBe(1000);

      // The production sub-keys must also be exactly consistent (sum = total).
      const promptSum = Number(await redis.get(PROMPT_SUB_KEY));
      const completionSum = Number(await redis.get(COMPLETION_SUB_KEY));
      expect(promptSum + completionSum).toBe(1000);

      // The production script sets TTLs on all four keys.
      for (const key of [DAILY_KEY, MONTHLY_KEY, PROMPT_SUB_KEY, COMPLETION_SUB_KEY]) {
        const ttl = await redis.ttl(key);
        expect(ttl).toBeGreaterThan(0);
      }
    } finally {
      // Clean up test keys to avoid interference with other test runs
      await redis.del(DAILY_KEY, MONTHLY_KEY).catch(() => {});
      await redis.quit();
    }
  });

  // NOTE: API-level budget-exhaustion tests are intentionally not included
  // here. The default E2E stack (docker-compose.yml) does not set a finite
  // AI_DAILY_TOKEN_BUDGET, so the API would always report unlimited headroom.
  // The budget atomicity is already covered above by directly exercising the
  // production Lua script, and unit tests in
  // backend/src/services/token-budget.test.ts cover the service wrapper.
});
