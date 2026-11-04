/**
 * Token budget tracking for AI provider token usage.
 *
 * Uses a Lua script to atomically check-and-increment daily and monthly
 * token counters. This prevents race conditions where two concurrent jobs
 * both read the budget, find it OK, and then both proceed — causing overshoot.
 *
 * The script returns {allowed: boolean, dailyUsed: number, monthlyUsed: number, reason?: string}.
 */

import { getSharedRedis } from '../lib/shared-redis.js';
import { logger } from './logger.js';

// Per-ioris-client error handler registration map — prevents duplicate handlers
// when getRedis() is called multiple times across the module lifetime.
const _redisErrorHandlerRegistered = new WeakMap<object, boolean>();

function getRedis(): ReturnType<typeof getSharedRedis> {
  const redis = getSharedRedis();
  if (!_redisErrorHandlerRegistered.get(redis)) {
    redis.on('error', (err: Error) => logger.warn({ err }, 'Token budget Redis error'));
    _redisErrorHandlerRegistered.set(redis, true);
  }
  return redis;
}

// ---------- Import env getters ----------

import { getMonthlyTokenBudget, getDailyTokenBudget } from '../config/env.js';

const SOFT_THRESHOLD = 0.8; // warn at 80%

// Fix #12: In-memory fallback counters. The previous version failed CLOSED
// in production whenever Redis was unreachable, blocking every story
// generation. That is the safer choice for a budget guard but it makes
// the platform brittle — one Redis blip, and no new stories can be
// created. We now keep an in-process counter that tracks tokens used
// while Redis is down, so when Redis recovers the cumulative spend is
// accurate. The counter is per-process; in a multi-worker deployment
// each worker tracks its own quota, which is acceptable degradation.
const inMemoryDaily = { day: todayKeyString(), used: 0 };
const inMemoryMonthly = { month: monthKeyString(), used: 0 };

function todayKeyString(): string {
  const d = new Date();
  return `tokens:day:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function monthKeyString(): string {
  const d = new Date();
  return `tokens:month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function rolloverIfNeededInMemory(): void {
  const day = todayKeyString();
  const month = monthKeyString();
  if (inMemoryDaily.day !== day) {
    inMemoryDaily.day = day;
    inMemoryDaily.used = 0;
  }
  if (inMemoryMonthly.month !== month) {
    inMemoryMonthly.month = month;
    inMemoryMonthly.used = 0;
  }
}

// ---------- Redis-backed Circuit Breaker State ----------
// REL-008 / REL-016: Circuit breaker for Redis failures — after 5 consecutive
// failures, all worker processes share the same breaker state via Redis.
// Key layout: circuit_breaker:redis_failures → Hash {failures, lastFailure, state}
// TTL matches resetTimeoutMs so stale state auto-expires if Redis is down.
//
// REL-016: Using Redis hash with HINCRBY for atomic increment avoids the
// read-modify-write race that existed when state was stored as a JSON string
// (two concurrent workers could both read, both increment in memory, and both
// write — losing one failure). The Lua script CB_RECORD_FAILURE_LUA is used
// by recordRedisFailure for the only non-idempotent operation.

interface RedisCircuitBreaker {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open';
  threshold: number;
  resetTimeoutMs: number;
}

const CB_KEY = 'circuit_breaker:redis_failures';

const redisCircuitBreaker: RedisCircuitBreaker = {
  failures: 0,
  lastFailure: 0,
  state: 'closed',
  threshold: 5,
  resetTimeoutMs: 60_000,
};

// REL-016: Lua script for atomic failure recording. Uses HINCRBY which is
// atomic in Redis, eliminating the read-modify-write race between workers.
const CB_RECORD_FAILURE_LUA = `
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('HSET', KEYS[1], 'lastFailure', ARGV[1])
local threshold = tonumber(ARGV[2])
local new_state = failures >= threshold and 'open' or 'closed'
redis.call('HSET', KEYS[1], 'state', new_state)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {failures, tonumber(ARGV[1]), new_state}
`;

/**
 * Atomically record a Redis failure via Lua script. Returns the new state.
 * This is the ONLY operation that modifies state with a race condition
 * risk (non-idempotent increment), so it's the only one that needs atomicity.
 */
async function _atomicRecordFailure(): Promise<{ failures: number; lastFailure: number; state: 'closed' | 'open' } | null> {
  try {
    const result = await getRedis().eval(
      CB_RECORD_FAILURE_LUA,
      1,
      CB_KEY,
      Date.now(),
      redisCircuitBreaker.threshold,
      Math.ceil(redisCircuitBreaker.resetTimeoutMs / 1000) + 5
    ) as [number, number, string];
    return { failures: result[0], lastFailure: result[1], state: result[2] as 'closed' | 'open' };
  } catch {
    return null;
  }
}

/**
 * Read circuit breaker state from Redis hash.
 * Returns the in-memory state if Redis is unreachable (per-process fallback).
 */
async function _getBreakerState(): Promise<RedisCircuitBreaker> {
  try {
    const raw = await getRedis().hgetall(CB_KEY);
    if (raw != null && Object.keys(raw).length > 0) {
      return {
        failures: parseInt(raw.failures ?? '0', 10) || 0,
        lastFailure: parseInt(raw.lastFailure ?? '0', 10) || 0,
        state: raw.state === 'open' ? 'open' : 'closed',
        threshold: redisCircuitBreaker.threshold,
        resetTimeoutMs: redisCircuitBreaker.resetTimeoutMs,
      };
    }
  } catch {
    // Redis unreachable — fall back to in-memory state
  }
  return { ...redisCircuitBreaker };
}

/**
 * Write circuit breaker state to Redis hash with TTL.
 * Silently ignores Redis errors so Redis failures never crash budget operations.
 */
async function _setBreakerState(state: RedisCircuitBreaker): Promise<void> {
  try {
    await getRedis().hset(CB_KEY, {
      failures: state.failures,
      lastFailure: state.lastFailure,
      state: state.state,
    });
    await getRedis().expire(CB_KEY, Math.ceil(redisCircuitBreaker.resetTimeoutMs / 1000) + 5);
  } catch {
    // Redis unreachable — state lives only in this process; next worker will
    // re-initialise from the default. This is the documented limitation.
  }
}

// ---------- Failure/Success Recording ----------

/**
 * Record a Redis failure, updating both in-memory state and Redis.
 * When threshold is reached the breaker trips to OPEN and the error is logged
 * at CRITICAL so it surfaces in alerting dashboards.
 *
 * NOTE: If Redis itself is down, writes to Redis will silently fail and state
 * remains per-process. Workers that cannot reach Redis will each track their own
 * failures independently — this is the documented fallback limitation.
 */
async function recordRedisFailure(): Promise<void> {
  // REL-016: Use atomic Lua script to avoid read-modify-write race.
  const atomic = await _atomicRecordFailure();
  if (atomic) {
    redisCircuitBreaker.failures = atomic.failures;
    redisCircuitBreaker.lastFailure = atomic.lastFailure;
    redisCircuitBreaker.state = atomic.state;
    if (atomic.state === 'open') {
      logger.error(
        { failures: atomic.failures, threshold: redisCircuitBreaker.threshold },
        'TOKEN BUDGET CIRCUIT BREAKER OPEN — Redis budget enforcement disabled'
      );
    }
    return;
  }
  // Redis unreachable — fall back to in-memory state (per-process only, acceptable degradation)
  redisCircuitBreaker.failures++;
  redisCircuitBreaker.lastFailure = Date.now();
  if (redisCircuitBreaker.failures >= redisCircuitBreaker.threshold) {
    redisCircuitBreaker.state = 'open';
    logger.error(
      { failures: redisCircuitBreaker.failures, threshold: redisCircuitBreaker.threshold },
      'TOKEN BUDGET CIRCUIT BREAKER OPEN (in-memory) — Redis budget enforcement disabled'
    );
  }
}

function recordRedisSuccess(): void {
  redisCircuitBreaker.failures = 0;
  redisCircuitBreaker.state = 'closed';
  // Fire-and-forget: best-effort sync to Redis; ignore errors.
  _setBreakerState({ ...redisCircuitBreaker }).catch(() => {});
}

async function isRedisBreakerOpen(): Promise<boolean> {
  const s = await _getBreakerState();
  if (s.state === 'closed') return false;
  if (Date.now() - s.lastFailure > s.resetTimeoutMs) {
    const reset: RedisCircuitBreaker = { ...s, state: 'closed', failures: 0 };
    await _setBreakerState(reset);
    return false;
  }
  return true;
}

// ---------- Key helpers ----------

function todayKey(): string {
  return todayKeyString();
}

function monthKey(): string {
  return monthKeyString();
}

// ---------- Atomic Lua script ----------
// Atomically checks budgets and increments usage in one round-trip.
// Returns 1 if allowed (and increments), 0 if rejected (no increment).
// Rejects if either daily or monthly limit would be exceeded AFTER increment.

// Separate sub-keys for prompt vs completion tracking (within the atomic script)
// Exported (test-only) so e2e race tests exercise THIS script — the actual
// production artifact — instead of a hand-written approximation (H20).
export const ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN_SCRIPT = `
local daily_key = KEYS[1]
local monthly_key = KEYS[2]
local prompt_sub_key = KEYS[3]
local completion_sub_key = KEYS[4]
local daily_limit = tonumber(ARGV[1])
local monthly_limit = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])

local daily_used = tonumber(redis.call('GET', daily_key) or '0')
local monthly_used = tonumber(redis.call('GET', monthly_key) or '0')

local new_daily = daily_used + amount
local new_monthly = monthly_used + amount

if (daily_limit > 0 and new_daily > daily_limit) then
  return {0, daily_used, monthly_used, 'daily exceeded'}
end
if (monthly_limit > 0 and new_monthly > monthly_limit) then
  return {0, daily_used, monthly_used, 'monthly exceeded'}
end

redis.call('INCRBY', daily_key, amount)
redis.call('EXPIRE', daily_key, 3024000)
redis.call('INCRBY', monthly_key, amount)
redis.call('EXPIRE', monthly_key, 6048000)
redis.call('INCRBY', prompt_sub_key, tonumber(ARGV[4]))
redis.call('EXPIRE', prompt_sub_key, 3024000)
redis.call('INCRBY', completion_sub_key, tonumber(ARGV[5]))
redis.call('EXPIRE', completion_sub_key, 3024000)

return {1, new_daily, new_monthly, 'ok'}
`;

const ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN = ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN_SCRIPT;

// REFUND_LUA: atomically decrements usage counters (called on pipeline failure rollback).
// Fix: Check key EXISTS before DECRBY to prevent creating negative counters on
// expired keys. When a daily/monthly key's TTL expires and gets deleted by Redis,
// a subsequent DECRBY would create it with value -amount, corrupting the budget
// and silently bypassing the cap until the key naturally expires again (30+ days).
// Now we only decrement keys that still exist, and set TTL to match the originals.
const REFUND_LUA = `
local daily_key = KEYS[1]
local monthly_key = KEYS[2]
local prompt_sub_key = KEYS[3]
local completion_sub_key = KEYS[4]
local prompt_amount = tonumber(ARGV[1])
local completion_amount = tonumber(ARGV[2])
local total = prompt_amount + completion_amount

if redis.call('EXISTS', daily_key) == 1 then
  redis.call('DECRBY', daily_key, total)
  redis.call('EXPIRE', daily_key, 3024000)
end
if redis.call('EXISTS', monthly_key) == 1 then
  redis.call('DECRBY', monthly_key, total)
  redis.call('EXPIRE', monthly_key, 6048000)
end
if redis.call('EXISTS', prompt_sub_key) == 1 then
  redis.call('DECRBY', prompt_sub_key, prompt_amount)
  redis.call('EXPIRE', prompt_sub_key, 3024000)
end
if redis.call('EXISTS', completion_sub_key) == 1 then
  redis.call('DECRBY', completion_sub_key, completion_amount)
  redis.call('EXPIRE', completion_sub_key, 3024000)
end

return {1, 'refunded'}
`;

// M28: Atomic reservation Lua script. Pre-charges an estimated token amount
// for a job against daily/monthly counters so concurrent jobs cannot all pass
// a read-only check and then collectively overshoot the budget. If the
// reservation key already exists for this jobId, the script is a no-op
// (idempotent) so retries and multiple gates do not double-charge.
const RESERVE_LUA = `
local daily_key = KEYS[1]
local monthly_key = KEYS[2]
local reserve_key = KEYS[3]
local daily_limit = tonumber(ARGV[1])
local monthly_limit = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if redis.call('EXISTS', reserve_key) == 1 then
  local daily_used = tonumber(redis.call('GET', daily_key) or '0')
  local monthly_used = tonumber(redis.call('GET', monthly_key) or '0')
  return {1, daily_used, monthly_used, 'already reserved'}
end

local daily_used = tonumber(redis.call('GET', daily_key) or '0')
local monthly_used = tonumber(redis.call('GET', monthly_key) or '0')

local new_daily = daily_used + amount
local new_monthly = monthly_used + amount

if daily_limit > 0 and new_daily > daily_limit then
  return {0, daily_used, monthly_used, 'daily exceeded'}
end
if monthly_limit > 0 and new_monthly > monthly_limit then
  return {0, monthly_used, monthly_used, 'monthly exceeded'}
end

redis.call('INCRBY', daily_key, amount)
redis.call('EXPIRE', daily_key, 3024000)
redis.call('INCRBY', monthly_key, amount)
redis.call('EXPIRE', monthly_key, 6048000)
redis.call('SET', reserve_key, amount, 'EX', ttl)

return {1, new_daily, new_monthly, 'ok'}
`;

// M28: Reconcile a reserved amount against the actual usage. The budget was
// pre-charged with the estimate; after the job finishes we adjust by
// (actual - estimate) and delete the reservation key. A positive delta
// charges extra, a negative delta refunds unused tokens.
const RECONCILE_LUA = `
local daily_key = KEYS[1]
local monthly_key = KEYS[2]
local reserve_key = KEYS[3]
local prompt_sub_key = KEYS[4]
local completion_sub_key = KEYS[5]
local delta = tonumber(ARGV[1])
local actual_prompt = tonumber(ARGV[2])
local actual_completion = tonumber(ARGV[3])

redis.call('DEL', reserve_key)

if delta > 0 then
  redis.call('INCRBY', daily_key, delta)
  redis.call('EXPIRE', daily_key, 3024000)
  redis.call('INCRBY', monthly_key, delta)
  redis.call('EXPIRE', monthly_key, 6048000)
elseif delta < 0 then
  local decr = -delta
  if redis.call('EXISTS', daily_key) == 1 then
    redis.call('DECRBY', daily_key, decr)
    redis.call('EXPIRE', daily_key, 3024000)
  end
  if redis.call('EXISTS', monthly_key) == 1 then
    redis.call('DECRBY', monthly_key, decr)
    redis.call('EXPIRE', monthly_key, 6048000)
  end
end

if actual_prompt >= 0 then
  redis.call('SET', prompt_sub_key, actual_prompt, 'EX', 3024000)
end
if actual_completion >= 0 then
  redis.call('SET', completion_sub_key, actual_completion, 'EX', 3024000)
end

return {1, 'reconciled'}
`;

// ---------- Public API ----------

export interface TokenBudgetStatus {
  daily: { used: number; limit: number; pct: number };
  monthly: { used: number; limit: number; pct: number };
  ok: boolean;
  reason?: string;
}

// M11: Track which charge path (Redis vs in-memory) was used for each job,
// so the refund goes to the correct path. Without this, if Redis was UP
// during charge but DOWN during refund, the Redis refund fails and the
// in-memory fallback is a no-op (in-memory counter was 0) — tokens are
// permanently consumed with no refund.
//
// Fix #3: Unbounded memory leak prevention.
// Entries are cleaned up on refund (already done) AND on success (new).
// Additionally, the map uses a simple LRU eviction strategy — when the map
// exceeds MAX_TRACKED_JOBS, the oldest entries (by insertion order) are
// evicted. This prevents memory growth from jobs that complete successfully
// without triggering a refund, or jobs whose refund call is lost due to a
// crash/restart.
const _chargeSourceMap = new Map<string, 'redis' | 'in-memory'>();
const MAX_TRACKED_JOBS = 1000;

function _trackChargeSource(jobId: string, source: 'redis' | 'in-memory'): void {
  // Evict oldest entries if at capacity (simple LRU via Map insertion order)
  if (_chargeSourceMap.size >= MAX_TRACKED_JOBS) {
    const oldestKey = _chargeSourceMap.keys().next().value;
    if (oldestKey !== undefined) {
      _chargeSourceMap.delete(oldestKey);
    }
  }
  _chargeSourceMap.set(jobId, source);
}

function _clearChargeSource(jobId: string): void {
  _chargeSourceMap.delete(jobId);
}

// HIGH-8: Per-job cumulative token spend tracking. When checkAndRecordTokenBudget
// is called with a jobId, the prompt and completion tokens are accumulated here.
// When refundTokenBudget is called, the real cumulative spend is returned instead
// of the hardcoded 0,0 that was previously used — which silently skipped the
// refund via the `total <= 0` early return.
interface JobTokenSpend {
  promptTokens: number;
  completionTokens: number;
  // M28: Reserved estimate pre-charged at the gate. Finalization uses this to
  // compute the delta (actual - reserved) and reconcile the budget counters.
  reservedAmount: number | null;
  // H11: The Redis keys the charge was recorded against. Refunds MUST
  // decrement these same keys — recomputing todayKey()/monthKey() at refund
  // time corrupts the counters when the refund lands in a different UTC
  // day/month than the charge (negative counters → budget bypass).
  dKey?: string | undefined;
  mKey?: string | undefined;
  promptSubKey?: string | undefined;
  completionSubKey?: string | undefined;
}
const _jobTokenSpend = new Map<string, JobTokenSpend>();
const MAX_TRACKED_SPEND_JOBS = 1000;

interface ChargeKeys {
  dKey: string;
  mKey: string;
  promptSubKey: string;
  completionSubKey: string;
}

function _trackTokenSpend(
  jobId: string,
  promptTokens: number,
  completionTokens: number,
  keys?: ChargeKeys,
  reservedAmount?: number
): void {
  if (_jobTokenSpend.size >= MAX_TRACKED_SPEND_JOBS) {
    const oldestKey = _jobTokenSpend.keys().next().value;
    if (oldestKey !== undefined) _jobTokenSpend.delete(oldestKey);
  }
  const existing = _jobTokenSpend.get(jobId);
  _jobTokenSpend.set(jobId, {
    promptTokens: (existing?.promptTokens ?? 0) + promptTokens,
    completionTokens: (existing?.completionTokens ?? 0) + completionTokens,
    reservedAmount: reservedAmount ?? existing?.reservedAmount ?? null,
    // First-charge keys win: the refund targets the period the spend was
    // actually recorded in. (Charges spanning a UTC boundary within one job
    // are still approximated — see H11 note in refundTokenBudget.)
    dKey: existing?.dKey ?? keys?.dKey,
    mKey: existing?.mKey ?? keys?.mKey,
    promptSubKey: existing?.promptSubKey ?? keys?.promptSubKey,
    completionSubKey: existing?.completionSubKey ?? keys?.completionSubKey,
  });
}

function _getAndClearTokenSpend(jobId: string): JobTokenSpend | null {
  const spend = _jobTokenSpend.get(jobId) ?? null;
  _jobTokenSpend.delete(jobId);
  return spend;
}

export function __getTrackedJobCount(): number {
  return _chargeSourceMap.size;
}

/**
 * M28: Finalize the per-job budget reservation. If the job was pre-charged
 * with an estimate at the gate, this adjusts the daily/monthly counters by
 * (actual - reserved) and deletes the reservation key. If the job was not
 * reserved (e.g., legacy callers or zero estimate), this only clears the
 * in-memory tracking maps. Called on both success and failure paths.
 */
export async function finalizeTokenBudget(
  jobId: string,
  actualPromptTokens?: number,
  actualCompletionTokens?: number
): Promise<TokenBudgetStatus> {
  const DAILY_BUDGET = getDailyTokenBudget();
  const MONTHLY_BUDGET = getMonthlyTokenBudget();
  const spend = _jobTokenSpend.get(jobId);

  if (!spend || spend.reservedAmount === null || !spend.dKey || !spend.mKey) {
    _jobTokenSpend.delete(jobId);
    _chargeSourceMap.delete(jobId);
    return {
      daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
      monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
      ok: true,
    };
  }

  const actualPrompt = actualPromptTokens ?? spend.promptTokens;
  const actualCompletion = actualCompletionTokens ?? spend.completionTokens;
  const actualTotal = actualPrompt + actualCompletion;
  const delta = actualTotal - spend.reservedAmount;
  const reserveKey = `tokens:reserved:${jobId}`;

  try {
    if (delta !== 0) {
      await getRedis().eval(
        RECONCILE_LUA,
        5,
        spend.dKey,
        spend.mKey,
        reserveKey,
        spend.promptSubKey ?? `${spend.dKey}:prompt`,
        spend.completionSubKey ?? `${spend.dKey}:completion`,
        delta,
        actualPrompt,
        actualCompletion
      );
    } else {
      await getRedis().del(reserveKey);
    }
    recordRedisSuccess();
  } catch (err) {
    await recordRedisFailure();
    if (process.env.NODE_ENV === 'production') {
      logger.error(
        { err, jobId, delta, reservedAmount: spend.reservedAmount },
        'Token budget finalization Redis failure in production — failing closed'
      );
      return {
        daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
        monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
        ok: false,
        reason: 'budget_service_unavailable',
      };
    }
    rolloverIfNeededInMemory();
    if (delta > 0) {
      inMemoryDaily.used += delta;
      inMemoryMonthly.used += delta;
    } else if (delta < 0) {
      inMemoryDaily.used = Math.max(0, inMemoryDaily.used + delta);
      inMemoryMonthly.used = Math.max(0, inMemoryMonthly.used + delta);
    }
    logger.warn(
      { err, jobId, delta },
      'Token budget finalization Redis failure — reconciling in-memory only'
    );
  }

  _jobTokenSpend.delete(jobId);
  _chargeSourceMap.delete(jobId);

  return {
    daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
    monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
    ok: true,
  };
}

/**
 * Clean up per-job token spend tracking entry. Called on pipeline success
 * so the map doesn't accumulate entries for completed jobs (bounded by
 * MAX_TRACKED_SPEND_JOBS via LRU, but explicit cleanup is cleaner).
 * M28: This now finalizes any reservation before clearing the maps.
 */
export function clearTokenSpend(jobId: string): void {
  finalizeTokenBudget(jobId).catch((err) =>
    logger.warn({ err, jobId }, 'Token budget finalization failed during clearTokenSpend')
  );
}

/**
 * Record token usage and simultaneously check the budget.
 * This is the primary entry point — it atomically checks AND increments
 * so no race condition is possible.
 *
 * Returns {ok, daily, monthly, reason} — throws only on Redis infrastructure failure.
 */
export async function checkAndRecordTokenBudget(
  promptTokens: number,
  completionTokens: number,
  jobId?: string
): Promise<TokenBudgetStatus> {
  const DAILY_BUDGET = getDailyTokenBudget();
  const MONTHLY_BUDGET = getMonthlyTokenBudget();

  const total = (promptTokens || 0) + (completionTokens || 0);
  if (total <= 0) {
    return {
      daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
      monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
      ok: true,
    };
  }

  // M28: If this job already reserved budget at the gate, do not double-charge
  // the global counters. Accumulate the actual usage in the per-job tracker;
  // finalizeTokenBudget will adjust by (actual - estimate) at completion.
  const spend = jobId ? _jobTokenSpend.get(jobId) : undefined;
  if (spend && spend.reservedAmount !== null) {
    _trackTokenSpend(jobId!, promptTokens || 0, completionTokens || 0);
    return {
      daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
      monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
      ok: true,
    };
  }

  const dKey = todayKey();
  const mKey = monthKey();
  const promptSubKey = `${dKey}:prompt`;
  const completionSubKey = `${dKey}:completion`;

  try {
    const result = (await getRedis().eval(
      ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN,
      4,
      dKey,
      mKey,
      promptSubKey,
      completionSubKey,
      DAILY_BUDGET,
      MONTHLY_BUDGET,
      total,
      promptTokens || 0,
      completionTokens || 0
    )) as [number, number, number, string];

    const [allowed, newDaily, newMonthly, status] = result;

    const dailyPct = DAILY_BUDGET > 0 ? newDaily / DAILY_BUDGET : 0;
    const monthlyPct = MONTHLY_BUDGET > 0 ? newMonthly / MONTHLY_BUDGET : 0;

    if (allowed === 0) {
      return {
        daily: { used: newDaily, limit: DAILY_BUDGET, pct: dailyPct },
        monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: monthlyPct },
        ok: false,
        reason: `Token budget exceeded (${status})`,
      };
    }

    // Soft threshold warnings — do not block, just log
    if (DAILY_BUDGET > 0 && dailyPct >= SOFT_THRESHOLD) {
      logger.warn(
        { dailyUsed: newDaily, DAILY_BUDGET, pct: Math.round(dailyPct * 100) },
        'Daily token budget at soft threshold'
      );
    }
    if (MONTHLY_BUDGET > 0 && monthlyPct >= SOFT_THRESHOLD) {
      logger.warn(
        { monthlyUsed: newMonthly, MONTHLY_BUDGET, pct: Math.round(monthlyPct * 100) },
        'Monthly token budget at soft threshold'
      );
    }

    // REL-008: Record success to reset circuit breaker
    recordRedisSuccess();

    // M11: Track that this charge went through Redis so the refund path
    // can skip the in-memory fallback and directly decrement Redis counters.
    // Previously the map was never populated — the .set() call was missing,
    // so every refund always tried Redis first (wasting one call) then fell
    // back to in-memory. Now the source is recorded, and refundTokenBudget
    // uses it to pick the correct path on the first attempt.
    if (jobId) _trackChargeSource(jobId, 'redis');

    // HIGH-8: Track per-job cumulative token spend so the refund uses real
    // numbers instead of hardcoded 0,0 (which caused the `total <= 0`
    // early return and silently skipped the refund).
    // H11: Record the charge keys too, so the refund decrements the SAME
    // period the charge hit (not whatever day/month it is at refund time).
    if (jobId) _trackTokenSpend(jobId, promptTokens || 0, completionTokens || 0, {
      dKey,
      mKey,
      promptSubKey,
      completionSubKey,
    });

    return {
      daily: { used: newDaily, limit: DAILY_BUDGET, pct: dailyPct },
      monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: monthlyPct },
      ok: true,
    };
  } catch (err) {
    // REL-008 / Fix #12: Redis failure — fail closed in production (reject
    // requests rather than allow unlimited usage when the budget guard is
    // unreachable), fail open in dev/test so local development is not
    // blocked by Redis outages.
    await recordRedisFailure();
    if (process.env.NODE_ENV === 'production') {
      logger.error(
        { err, failures: redisCircuitBreaker.failures },
        'Token budget Redis failure in production — rejecting request (fail-closed)'
      );
      return {
        daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
        monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
        ok: false,
        reason: 'budget_service_unavailable',
      };
    }
    // Dev/test: in-memory best-effort fallback
    rolloverIfNeededInMemory();
    const newDaily = inMemoryDaily.used + total;
    const newMonthly = inMemoryMonthly.used + total;
    if (DAILY_BUDGET > 0 && newDaily > DAILY_BUDGET) {
      logger.warn(
        { err, dailyUsed: newDaily, dailyBudget: DAILY_BUDGET },
        'Token budget: in-memory daily limit exceeded while Redis was down — rejecting'
      );
      return {
        daily: { used: newDaily, limit: DAILY_BUDGET, pct: newDaily / DAILY_BUDGET },
        monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: MONTHLY_BUDGET > 0 ? newMonthly / MONTHLY_BUDGET : 0 },
        ok: false,
        reason: 'Token budget exceeded (in-memory daily, Redis unavailable)',
      };
    }
    if (MONTHLY_BUDGET > 0 && newMonthly > MONTHLY_BUDGET) {
      logger.warn(
        { err, monthlyUsed: newMonthly, monthlyBudget: MONTHLY_BUDGET },
        'Token budget: in-memory monthly limit exceeded while Redis was down — rejecting'
      );
      return {
        daily: { used: newDaily, limit: DAILY_BUDGET, pct: DAILY_BUDGET > 0 ? newDaily / DAILY_BUDGET : 0 },
        monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: newMonthly / MONTHLY_BUDGET },
        ok: false,
        reason: 'Token budget exceeded (in-memory monthly, Redis unavailable)',
      };
    }
    inMemoryDaily.used = newDaily;
    inMemoryMonthly.used = newMonthly;

    // M11: Track that this charge went through the in-memory fallback so
    // the refund path can skip the Redis refund and go directly to in-memory.
    // This avoids the wasted Redis call that previously happened on every
    // in-memory-path refund.
    if (jobId) _trackChargeSource(jobId, 'in-memory');

    // HIGH-8: Track per-job cumulative token spend (in-memory path).
    if (jobId) _trackTokenSpend(jobId, promptTokens || 0, completionTokens || 0);

    logger.warn(
      { err, failures: redisCircuitBreaker.failures, total },
      'Token budget Redis failure — using in-memory fallback (best-effort enforcement)'
    );
    return {
      daily: { used: newDaily, limit: DAILY_BUDGET, pct: DAILY_BUDGET > 0 ? newDaily / DAILY_BUDGET : 0 },
      monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: MONTHLY_BUDGET > 0 ? newMonthly / MONTHLY_BUDGET : 0 },
      ok: true,
    };
  }
}

/**
 * Refund tokens on pipeline failure rollback.
 * Uses the same key structure as checkAndRecordTokenBudget.
 * Fix #12: also refunds the in-memory counter when Redis was unavailable
 * for the original check-and-record. Otherwise the in-memory counter
 * would slowly drift upward across restarts.
 */
export async function refundTokenBudget(
  jobId: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  const reserved = _jobTokenSpend.get(jobId);
  if (reserved && reserved.reservedAmount !== null) {
    // M28: In reservation mode, the budget was pre-charged with an estimate.
    // A failure-time "refund" is just a finalization: adjust the counters by
    // (actual - reserved) and delete the reservation key.
    await finalizeTokenBudget(jobId, promptTokens, completionTokens);
    return;
  }

  // HIGH-8: Use the tracked per-job cumulative spend instead of the
  // passed-in values. The caller passes 0,0 because the actual token
  // spend is spread across multiple checkAndRecordTokenBudget calls
  // during the pipeline. The tracked values are the real cumulative total.
  const tracked = _getAndClearTokenSpend(jobId);
  const actualPrompt = tracked?.promptTokens ?? promptTokens;
  const actualCompletion = tracked?.completionTokens ?? completionTokens;
  const total = (actualPrompt || 0) + (actualCompletion || 0);
  if (total <= 0) return;

  // H11: Use the keys recorded at CHARGE time. Recomputing todayKey()/
  // monthKey() at refund time decrements the wrong period when the refund
  // lands in a different UTC day/month than the charge — driving counters
  // negative (budget bypass) or silently skipping via the EXISTS guard.
  // Fall back to current keys only when the charge was never tracked (e.g.
  // the tracking entry was LRU-evicted or the process restarted).
  const dKey = tracked?.dKey ?? todayKey();
  const mKey = tracked?.mKey ?? monthKey();
  const promptSubKey = tracked?.promptSubKey ?? `${dKey}:prompt`;
  const completionSubKey = tracked?.completionSubKey ?? `${dKey}:completion`;

  // M11: Check which path was used for the charge. If the charge went through
  // Redis, refund via Redis. If it went through in-memory, refund in-memory.
  // If unknown, try Redis first and fall back to in-memory.
  const chargeSource = _chargeSourceMap.get(jobId);

  let redisOk = true;
  if (chargeSource !== 'in-memory') {
    try {
      await getRedis().eval(
        REFUND_LUA,
        4,
        dKey,
        mKey,
        promptSubKey,
        completionSubKey,
        actualPrompt || 0,
        actualCompletion || 0
      );
      logger.info({ jobId, total, promptTokens: actualPrompt, completionTokens: actualCompletion }, 'Token budget refunded after pipeline failure');
    } catch (err) {
      redisOk = false;
      logger.error({ err, jobId }, 'Token budget Redis refund failed — falling back to in-memory refund');
    }
  } else {
    // Charge was in-memory — skip Redis refund (it would fail or be a no-op)
    redisOk = false;
  }

  if (!redisOk || chargeSource === 'in-memory') {
    // Mirror the refund in the in-memory counter so it does not drift
    // upward over the lifetime of the process.
    rolloverIfNeededInMemory();
    inMemoryDaily.used = Math.max(0, inMemoryDaily.used - total);
    inMemoryMonthly.used = Math.max(0, inMemoryMonthly.used - total);
  }

  // Clean up the tracking entry
  _clearChargeSource(jobId);
}

/**
 * M28: Atomic budget gate. Two modes:
 *
 * 1. Read-only check (no options or estimatedTotal <= 0): returns the current
 *    budget state without recording usage. This is the legacy/advisory path.
 *
 * 2. Reservation check (options.estimatedTotal > 0 and options.jobId provided):
 *    atomically pre-charges the estimated tokens against the daily/monthly
 *    counters. Concurrent jobs can no longer pass a read-only check and then
 *    all spend real provider tokens before the later charge is recorded. The
 *    actual usage is tracked per-job; finalizeTokenBudget (called on success
 *    via clearTokenSpend, or on failure via refundTokenBudget) reconciles the
 *    estimate against actual usage and deletes the reservation key.
 *
 * REL-009: Uses Lua scripts for atomic read/reservation to prevent TOCTOU races.
 */
export async function checkTokenBudget(
  options?: { estimatedTotal?: number; jobId?: string }
): Promise<TokenBudgetStatus> {
  const DAILY_BUDGET = getDailyTokenBudget();
  const MONTHLY_BUDGET = getMonthlyTokenBudget();

  const dKey = todayKey();
  const mKey = monthKey();

  const estimatedTotal = options?.estimatedTotal ?? 0;
  const jobId = options?.jobId;

  if (estimatedTotal > 0 && jobId) {
    const reserveKey = `tokens:reserved:${jobId}`;
    try {
      const result = (await getRedis().eval(
        RESERVE_LUA,
        3,
        dKey,
        mKey,
        reserveKey,
        DAILY_BUDGET,
        MONTHLY_BUDGET,
        estimatedTotal,
        7200
      )) as [number, number, number, string];

      const [allowed, newDaily, newMonthly, status] = result;
      const dailyPct = DAILY_BUDGET > 0 ? newDaily / DAILY_BUDGET : 0;
      const monthlyPct = MONTHLY_BUDGET > 0 ? newMonthly / MONTHLY_BUDGET : 0;

      if (allowed === 0) {
        return {
          daily: { used: newDaily, limit: DAILY_BUDGET, pct: dailyPct },
          monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: monthlyPct },
          ok: false,
          reason: `Token budget exceeded (${status})`,
        };
      }

      _trackTokenSpend(
        jobId,
        0,
        0,
        { dKey, mKey, promptSubKey: `${dKey}:prompt`, completionSubKey: `${dKey}:completion` },
        estimatedTotal
      );
      recordRedisSuccess();

      if (DAILY_BUDGET > 0 && dailyPct >= SOFT_THRESHOLD) {
        logger.warn(
          { dailyUsed: newDaily, DAILY_BUDGET, pct: Math.round(dailyPct * 100) },
          'Daily token budget at soft threshold'
        );
      }
      if (MONTHLY_BUDGET > 0 && monthlyPct >= SOFT_THRESHOLD) {
        logger.warn(
          { monthlyUsed: newMonthly, MONTHLY_BUDGET, pct: Math.round(monthlyPct * 100) },
          'Monthly token budget at soft threshold'
        );
      }

      return {
        daily: { used: newDaily, limit: DAILY_BUDGET, pct: dailyPct },
        monthly: { used: newMonthly, limit: MONTHLY_BUDGET, pct: monthlyPct },
        ok: true,
      };
    } catch (err) {
      await recordRedisFailure();
      if (process.env.NODE_ENV === 'production') {
        logger.error(
          { err, failures: redisCircuitBreaker.failures },
          'Token budget Redis reservation failed in production — rejecting request (fail-closed)'
        );
        return {
          daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
          monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
          ok: false,
          reason: 'budget_service_unavailable',
        };
      }
      const open = await isRedisBreakerOpen();
      if (open) {
        logger.error(
          { err, failures: redisCircuitBreaker.failures },
          'TOKEN BUDGET CIRCUIT BREAKER OPEN — Redis budget reservation denied'
        );
        return {
          daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
          monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
          ok: false,
          reason: 'Token budget circuit breaker is open — consumption denied',
        };
      }
      logger.warn({ err }, 'Failed to reserve token budget; allowing request (fail-open)');
      return {
        daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
        monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
        ok: true,
      };
    }
  }

  let dailyUsed = 0;
  let monthlyUsed = 0;

  try {
    // REL-009: Atomic Lua read — prevents race between check and actual increment
    const result = (await getRedis().eval(
      `
      local daily = redis.call('GET', KEYS[1]) or '0'
      local monthly = redis.call('GET', KEYS[2]) or '0'
      return {tonumber(daily), tonumber(monthly)}
      `,
      2,
      dKey,
      mKey
    )) as [number, number];

    [dailyUsed, monthlyUsed] = result;
  } catch (err) {
    // REL-008 / HIGH #19: Redis failure — fail CLOSED in production because a
    // read-only check that silently passes lets workers consume unlimited quota
    // when Redis is down, breaking cross-worker budget enforcement. In dev/test,
    // keep the fail-open behaviour so local development isn't blocked.
    await recordRedisFailure();
    if (process.env.NODE_ENV === 'production') {
      logger.error(
        { err, failures: redisCircuitBreaker.failures },
        'Token budget Redis read failed in production — rejecting request (fail-closed)'
      );
      return {
        daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
        monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
        ok: false,
        reason: 'budget_service_unavailable',
      };
    }
    const open = await isRedisBreakerOpen();
    if (open) {
      logger.error(
        { err, failures: redisCircuitBreaker.failures },
        'TOKEN BUDGET CIRCUIT BREAKER OPEN — Redis budget check disabled for this request'
      );
      return {
        daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
        monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
        ok: false,
        reason: 'Token budget circuit breaker is open — consumption denied',
      };
    }
    logger.warn({ err }, 'Failed to read token budget; allowing request (fail-open)');
    return {
      daily: { used: 0, limit: DAILY_BUDGET, pct: 0 },
      monthly: { used: 0, limit: MONTHLY_BUDGET, pct: 0 },
      ok: true,
    };
  }

  const dailyPct = DAILY_BUDGET > 0 ? dailyUsed / DAILY_BUDGET : 0;
  const monthlyPct = MONTHLY_BUDGET > 0 ? monthlyUsed / MONTHLY_BUDGET : 0;

  if (DAILY_BUDGET > 0 && dailyUsed >= DAILY_BUDGET) {
    return {
      daily: { used: dailyUsed, limit: DAILY_BUDGET, pct: dailyPct },
      monthly: { used: monthlyUsed, limit: MONTHLY_BUDGET, pct: monthlyPct },
      ok: false,
      reason: `Daily token budget exceeded (${dailyUsed}/${DAILY_BUDGET})`,
    };
  }
  if (MONTHLY_BUDGET > 0 && monthlyUsed >= MONTHLY_BUDGET) {
    return {
      daily: { used: dailyUsed, limit: DAILY_BUDGET, pct: dailyPct },
      monthly: { used: monthlyUsed, limit: MONTHLY_BUDGET, pct: monthlyPct },
      ok: false,
      reason: `Monthly token budget exceeded (${monthlyUsed}/${MONTHLY_BUDGET})`,
    };
  }
  if (DAILY_BUDGET > 0 && dailyPct >= SOFT_THRESHOLD) {
    logger.warn(
      { dailyUsed, DAILY_BUDGET, pct: Math.round(dailyPct * 100) },
      'Daily token budget at soft threshold'
    );
  }
  if (MONTHLY_BUDGET > 0 && monthlyPct >= SOFT_THRESHOLD) {
    logger.warn(
      { monthlyUsed, MONTHLY_BUDGET, pct: Math.round(monthlyPct * 100) },
      'Monthly token budget at soft threshold'
    );
  }

  return {
    daily: { used: dailyUsed, limit: DAILY_BUDGET, pct: dailyPct },
    monthly: { used: monthlyUsed, limit: MONTHLY_BUDGET, pct: monthlyPct },
    ok: true,
  };
}