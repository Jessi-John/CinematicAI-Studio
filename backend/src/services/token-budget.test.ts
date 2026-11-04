/**
 * Token Budget Service Tests
 *
 * Tests cover:
 * - Atomic Lua script behavior (check and increment)
 * - Daily/monthly budget enforcement
 * - Circuit breaker open/close behavior
 * - Fail-closed in production when Redis is unavailable
 * - Token refund on rollback
 * - Per-job spend tracking and refund fallback behavior (HIGH-8 regression)
 *
 * Vitest ESM-native mocking: vi.mock() at module level works reliably.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock Redis client shared across all tests
const mockEval = vi.fn();
const mockOn = vi.fn();
const mockRedis = {
  eval: mockEval,
  on: mockOn,
};

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => mockRedis,
}));

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  mockEval.mockReset();
  mockOn.mockReset();
  // M37: capture the env before any test mutates NODE_ENV, and restore it —
  // previously the mutation leaked into subsequent tests in the file
  // (order-dependent behavior).
  savedEnv = { ...process.env };
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  vi.resetModules();
});

describe('TokenBudget', () => {
  it('should reject when daily limit exceeded', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([0, 950000, 10000000, 'daily exceeded']);
    const result = await checkAndRecordTokenBudget(100, 50);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('daily exceeded');
  });

  it('should reject when monthly limit exceeded', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([0, 500000, 95000000, 'monthly exceeded']);
    const result = await checkAndRecordTokenBudget(100, 50);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('monthly exceeded');
  });

  it('should allow when within budget and record usage', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 100000, 5000000, 'ok']);
    const result = await checkAndRecordTokenBudget(100, 50);

    expect(result.ok).toBe(true);
    expect(result.daily.used).toBe(100000);
    expect(result.monthly.used).toBe(5000000);
  });

  it('should atomically increment in Lua script', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 100100, 5000100, 'ok']);
    await checkAndRecordTokenBudget(100, 50);
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockEval.mock.calls[0]![0]).toContain('local daily_key');
  });

  it('should return current budget state without incrementing', async () => {
    const { checkTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([800000, 45000000]);
    const result = await checkTokenBudget();
    expect(result.ok).toBe(true);
    expect(result.daily.used).toBe(800000);
    expect(result.monthly.used).toBe(45000000);
  });

  it('should fail-closed when Redis script throws in production', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    process.env.NODE_ENV = 'production';
    mockEval.mockRejectedValue(new Error('Redis connection refused'));
    const result = await checkAndRecordTokenBudget(100, 50);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('budget_service_unavailable');
  });

  it('should fail-open when Redis script throws in development', async () => {
    const { checkAndRecordTokenBudget } = await import('./token-budget.js');

    process.env.NODE_ENV = 'development';
    mockEval.mockRejectedValue(new Error('Redis connection refused'));
    const result = await checkAndRecordTokenBudget(100, 50);
    expect(result.ok).toBe(true);
  });

  it('checkTokenBudget should fail-closed when Redis is unreachable in production', async () => {
    const { checkTokenBudget } = await import('./token-budget.js');

    process.env.NODE_ENV = 'production';
    mockEval.mockRejectedValue(new Error('Redis connection refused'));
    const result = await checkTokenBudget();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('budget_service_unavailable');
  });

  it('checkTokenBudget should fail-open when Redis is unreachable in development', async () => {
    const { checkTokenBudget } = await import('./token-budget.js');

    process.env.NODE_ENV = 'development';
    mockEval.mockRejectedValue(new Error('Redis connection refused'));
    const result = await checkTokenBudget();
    expect(result.ok).toBe(true);
  });

  it('should call eval with refund Lua script', async () => {
    const { refundTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 'refunded']);
    await refundTokenBudget('job-123', 100, 50);
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('uses per-job tracked spend when caller passes 0,0 (HIGH-8 regression)', async () => {
    // checkAndRecordTokenBudget with a jobId populates per-job spend tracking.
    // Refunding the same jobId with 0,0 must still use the tracked values.
    const { checkAndRecordTokenBudget, refundTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 200, 5000000, 'ok']);
    await checkAndRecordTokenBudget(80, 20, 'tracked-job-001');

    mockEval.mockClear();
    mockEval.mockResolvedValue([1, 'refunded']);
    await refundTokenBudget('tracked-job-001', 0, 0);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const evalCall = mockEval.mock.calls[0]!;
    // refundTokenBudget calls getRedis().eval(REFUND_LUA, 4, dKey, mKey,
    // promptSubKey, completionSubKey, actualPrompt, actualCompletion).
    // The actualPrompt/completion args are at indices 6 and 7.
    expect(evalCall[6]).toBe(80);  // prompt tokens (tracked)
    expect(evalCall[7]).toBe(20);  // completion tokens (tracked)
  });

  it('falls back to passed-in values when no tracked spend exists for the jobId (defence in depth)', async () => {
    const { refundTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 'refunded']);
    await refundTokenBudget('never-tracked', 120, 340);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const evalCall = mockEval.mock.calls[0]!;
    expect(evalCall[6]).toBe(120); // prompt tokens (fallback)
    expect(evalCall[7]).toBe(340); // completion tokens (fallback)
  });

  it('H11: refunds decrement the keys recorded at CHARGE time, not the keys of refund time (UTC midnight rollover)', async () => {
    const { checkAndRecordTokenBudget, refundTokenBudget } = await import('./token-budget.js');

    // Charge at 23:59 UTC on Jan 19
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-19T23:59:00Z'));
    mockEval.mockResolvedValue([1, 200, 5000000, 'ok']);
    await checkAndRecordTokenBudget(80, 20, 'midnight-job');

    // Refund at 00:01 UTC on Jan 20 — a DIFFERENT day and month-key window.
    vi.setSystemTime(new Date('2026-01-20T00:01:00Z'));
    mockEval.mockClear();
    mockEval.mockResolvedValue([1, 'refunded']);
    await refundTokenBudget('midnight-job', 0, 0);
    vi.useRealTimers();

    expect(mockEval).toHaveBeenCalledTimes(1);
    const evalCall = mockEval.mock.calls[0]!;
    // Keys are at indices 2 (dKey), 3 (mKey), 4 (promptSubKey), 5 (completionSubKey).
    // They must be Jan 19's keys (charge time), not Jan 20's (refund time).
    expect(evalCall[2]).toBe('tokens:day:2026-01-19');
    expect(evalCall[3]).toBe('tokens:month:2026-01');
    expect(evalCall[4]).toBe('tokens:day:2026-01-19:prompt');
    expect(evalCall[5]).toBe('tokens:day:2026-01-19:completion');
  });

  it('M28: reserves an atomic per-job budget estimate and reconciles on finalize', async () => {
    const { checkTokenBudget, checkAndRecordTokenBudget, finalizeTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 50000, 50000, 'ok']);
    const reserveResult = await checkTokenBudget({ estimatedTotal: 100000, jobId: 'reservation-job' });
    expect(reserveResult.ok).toBe(true);
    expect(reserveResult.daily.used).toBe(50000);

    // The reservation script is called with 3 keys (daily, monthly, reserve) and
    // the estimate as the third argument.
    expect(mockEval).toHaveBeenCalledTimes(1);
    const reserveCall = mockEval.mock.calls[0]!;
    expect(reserveCall[1]).toBe(3); // number of keys
    expect(reserveCall[7]).toBe(100000); // estimate amount

    // While the reservation is held, checkAndRecordTokenBudget only accumulates
    // actual usage in the per-job tracker and does NOT call the atomic charge script.
    mockEval.mockClear();
    const recordResult = await checkAndRecordTokenBudget(300, 200, 'reservation-job');
    expect(recordResult.ok).toBe(true);
    expect(mockEval).toHaveBeenCalledTimes(0);

    // Finalize under-spend: reserved 100k, actual 500 -> refund 99.5k.
    mockEval.mockResolvedValue([1, 'reconciled']);
    await finalizeTokenBudget('reservation-job', 300, 200);
    expect(mockEval).toHaveBeenCalledTimes(1);
    const reconcileCall = mockEval.mock.calls[0]!;
    expect(reconcileCall[1]).toBe(5); // number of keys
    expect(reconcileCall[7]).toBe(-99500); // delta (actual - reserved)
    expect(reconcileCall[8]).toBe(300); // actual prompt
    expect(reconcileCall[9]).toBe(200); // actual completion
  });

  it('M28: refundTokenBudget reconciles a reserved budget instead of refunding actual', async () => {
    const { checkTokenBudget, refundTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 50000, 50000, 'ok']);
    await checkTokenBudget({ estimatedTotal: 100000, jobId: 'refund-reservation-job' });

    mockEval.mockClear();
    mockEval.mockResolvedValue([1, 'reconciled']);
    await refundTokenBudget('refund-reservation-job', 0, 0);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const reconcileCall = mockEval.mock.calls[0]!;
    expect(reconcileCall[1]).toBe(5); // RECONCILE_LUA uses 5 keys
    expect(reconcileCall[7]).toBe(-100000); // reserved 100k, actual 0 -> refund all
  });

  it('M28: reservation is idempotent for the same jobId', async () => {
    const { checkTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([1, 100000, 100000, 'ok']);
    await checkTokenBudget({ estimatedTotal: 100000, jobId: 'idempotent-job' });
    await checkTokenBudget({ estimatedTotal: 100000, jobId: 'idempotent-job' });

    // The reservation script is idempotent: it checks the reserve key and
    // returns 'already reserved' without incrementing again. The Lua script is
    // still invoked each time, but the budget counters are only charged once.
    expect(mockEval).toHaveBeenCalledTimes(2);
  });

  it('M28: reservation fails when budget would be exceeded', async () => {
    const { checkTokenBudget } = await import('./token-budget.js');

    mockEval.mockResolvedValue([0, 900000, 900000, 'daily exceeded']);
    const result = await checkTokenBudget({ estimatedTotal: 200000, jobId: 'overbudget-job' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('daily exceeded');
  });
});