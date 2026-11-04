import { isRetriableStatus, calculateDelay } from './retry.js';
import { sleep } from './sleep.js';
import { sanitizeAIResponse, safeJsonParse } from './sanitize.js';
import { sanitizeForPrompt } from './sanitize-prompt.js';
import { logger } from '../services/logger.js';
import type { YouTubeSEO } from '../services/types.js';
import { isCannedMode, cannedChatResponse } from './ai-client.canned.js';
import { createWatchdogAbortController } from './watchdog.js';
import { getMistralApiKey, getMistralBaseUrl, getMistralModel, getKimiApiKey, getKimiBaseUrl, getKimiModel, isPlaceholder } from '../config/env.js';
import { checkAndRecordTokenBudget } from '../services/token-budget.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// H4+M11: Per-pipeline async context. The previous module-level jobId and
// abortSignal were overwritten when a previous job finished while another job's
// AI calls were still in flight (e.g., concurrent stages, Promise.all, or a job
// retry clearing globals). AsyncLocalStorage binds the context to the async
// call stack so each pipeline's calls see their own jobId and abort signal.
interface AIPipelineContext {
  jobId: string | null;
  abortSignal: AbortSignal | null;
  /** Per-pipeline flag: when true, generateWithMistral returns canned responses
   *  instead of calling real AI providers. Stored in AsyncLocalStorage so
   *  concurrent pipelines do not interfere with each other. */
  cannedFallbackEnabled: boolean;
}
// YouTube display-title limit is 100 characters. Used in the SEO prompt and
// post-processing — both must stay in sync so the AI targets the correct cap
// and the code enforces it cleanly (no mid-word truncation).
const YOUTUBE_TITLE_MAX_LENGTH = 100;

// Token-estimation heuristic for providers that don't return per-call usage.
// This is intentionally simple (1 token ≈ 4 characters) so it never blocks
// generation when usage metadata is missing.
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Record prompt + completion tokens against the daily/monthly budget.
 * Called by each provider after a successful AI response. Failures are logged
 * but never throw, so token accounting can't break a generation in flight.
 */
async function recordProviderUsage(
  promptTokens: number,
  completionTokens: number,
  provider: string
): Promise<void> {
  const jobId = getCurrentAIPipelineJobId();
  try {
    const status = await checkAndRecordTokenBudget(
      promptTokens,
      completionTokens,
      jobId ?? undefined
    );
    if (!status.ok) {
      logger.warn(
        { provider, jobId, reason: status.reason },
        'Token budget check failed after AI call'
      );
    }
  } catch (err) {
    logger.warn({ provider, jobId, err }, 'Token budget recording failed after AI call');
  }
}

const aiPipelineContext = new AsyncLocalStorage<AIPipelineContext>();

function getCurrentAIPipelineContext(): AIPipelineContext {
  return aiPipelineContext.getStore() ?? { jobId: null, abortSignal: null, cannedFallbackEnabled: false };
}

/**
 * Run a function inside a per-pipeline AI context. All AI calls made within
 * `fn` (including across awaits and Promise.all branches) will see the given
 * jobId and abortSignal without interfering with concurrent pipelines.
 */
export function runWithAIPipelineContext<T>(
  jobId: string,
  abortSignal: AbortSignal | null,
  fn: () => Promise<T>,
  cannedFallbackEnabled?: boolean
): Promise<T> {
  return aiPipelineContext.run({ jobId, abortSignal, cannedFallbackEnabled: cannedFallbackEnabled ?? false }, fn);
}

/**
 * Test-only helper to read the current AI pipeline context.
 * Exported so unit tests can assert context isolation without reaching
 * into private internals.
 */
export function __getPipelineContextForTest(): AIPipelineContext {
  return getCurrentAIPipelineContext();
}

/**
 * Read the current pipeline job id from async context. Background jobs can
 * use this to attribute AI calls to the originating job without plumbing
 * jobId through every helper signature.
 */
export function getCurrentAIPipelineJobId(): string | null {
  return getCurrentAIPipelineContext().jobId;
}

/** Check if the pipeline has been aborted. Throws if aborted. */
function checkPipelineAborted(): void {
  const { abortSignal } = getCurrentAIPipelineContext();
  if (abortSignal?.aborted) {
    throw new Error('Pipeline aborted — AI call cancelled by pipeline timeout');
  }
}

/** Combine the pipeline abort signal with a per-call watchdog signal. */
function combineAbortSignals(watchdogSignal: AbortSignal): AbortSignal {
  const { abortSignal: pipelineSignal } = getCurrentAIPipelineContext();
  if (!pipelineSignal) return watchdogSignal;
  if (pipelineSignal.aborted) {
    const c = new AbortController();
    c.abort(new Error('Pipeline aborted'));
    return c.signal;
  }
  // Use AbortSignal.any() if available (Node 20+), otherwise manual combine
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([watchdogSignal, pipelineSignal]);
  }
  // Fallback for older Node: create a new controller that aborts when either fires.
  // Use a `fired` flag to prevent double-abort: when both signals fire in the same
  // microtask, both listeners run before either `{ once: true }` cleanup removes the
  // other, causing controller.abort() to fire twice (harmless) and one listener to leak.
  const combined = new AbortController();
  let fired = false;
  const handler = () => {
    if (!fired) {
      fired = true;
      // L3: remove the sibling listener so it doesn't linger on the source
      // signal until GC.
      watchdogSignal.removeEventListener('abort', handler);
      pipelineSignal.removeEventListener('abort', handler);
      combined.abort();
    }
  };
  watchdogSignal.addEventListener('abort', handler, { once: true });
  pipelineSignal.addEventListener('abort', handler, { once: true });
  return combined.signal;
}

// ---------- Sliding window rate limiter ----------

interface SlidingWindowRateLimiter {
  maxRequests: number;
  windowMs: number;
  timestamps: number[];
  _lock: Promise<void>;
}

export function __createRateLimiter(maxRequests: number, windowMs: number): SlidingWindowRateLimiter {
  return { maxRequests, windowMs, timestamps: [], _lock: Promise.resolve() };
}

const createRateLimiter = __createRateLimiter;

export async function __waitForRateLimit(limiter: SlidingWindowRateLimiter, providerLabel = 'AI provider'): Promise<void> {
  while (true) {
    // Acquire mutex — serialize concurrent callers so they don't all
    // pass the length check before any push their timestamp.
    let release: () => void = undefined!;
    const nextLock = new Promise<void>(resolve => { release = resolve; });
    const prevLock = limiter._lock;
    limiter._lock = nextLock;
    await prevLock;

    // L2: capture the oldest timestamp INSIDE the mutex — reading it after
    // release raced with concurrent push/filter and could compute a bogus wait.
    let waitMs = 0;
    let queued = 0;
    try {
      const now = Date.now();
      limiter.timestamps = limiter.timestamps.filter(t => now - t < limiter.windowMs);
      if (limiter.timestamps.length < limiter.maxRequests) {
        limiter.timestamps.push(now);
        return;
      }
      const oldestTimestamp = limiter.timestamps[0]!;
      queued = limiter.timestamps.length;
      waitMs = limiter.windowMs - (now - oldestTimestamp) + 100;
    } finally {
      release!();
    }

    // Rate limited — sleep outside the mutex so other callers can proceed
    logger.warn(
      { waitMs: Math.round(waitMs), queuedRequests: queued },
      `${providerLabel} rate limit reached — waiting ${Math.round(waitMs)}ms for next slot`
    );
    await sleep(waitMs);
  }
}

const mistralRateLimiter = createRateLimiter(20, 60_000);
const kimiRateLimiter = createRateLimiter(30, 60_000);

function emitRequestStart(model: string): void {
  if (metricsHooks.onRequestStart) metricsHooks.onRequestStart(model);
}

function emitRequestSuccess(model: string, durationMs: number, tokens: number): void {
  if (metricsHooks.onRequestSuccess) metricsHooks.onRequestSuccess(model, durationMs / 1000, tokens);
}

function emitRequestFailure(model: string, status?: number): void {
  if (metricsHooks.onRequestFailure) metricsHooks.onRequestFailure(model, status);
}

// ---------- Circuit breaker ----------
// REL-001: Uses a Promise mutex (halfOpenProbeLock) instead of an integer counter
// to ensure only one request can enter the half-open probe slot at a time.
// The Promise-based approach is inherently synchronous in its critical section,
// preventing race conditions that occur with plain integer increment/decrement.

export interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
  threshold: number;
  resetTimeout: number;
  baseResetTimeout: number;
  maxResetTimeout: number;
  // Promise mutex — only one request holds this at a time in half-open state.
  // null = no request holds the probe lock
  // Promise = a request is in flight as the half-open probe
  halfOpenProbeLock: Promise<void> | null;
  // H3: Timestamp of probe acquisition, used by the stale-lock TTL so a probe
  // that never resolves (any path that bypassed the record helpers) is force-
  // released instead of wedging the provider until process restart.
  halfOpenProbeLockedAt?: number | undefined;
}

// Mistral AI circuit breaker — primary provider for both blueprint and content stages.
const mistralCircuitBreaker: CircuitBreaker = {
  failures: 0,
  lastFailure: 0,
  state: 'closed',
  threshold: 5,
  resetTimeout: 60000,
  baseResetTimeout: 60000,
  maxResetTimeout: 1800000,
  halfOpenProbeLock: null,
};

// Kimi K3 circuit breaker — fallback for story blueprints, bibles, episodes, scenes, dialogue, SEO.
const kimiCircuitBreaker: CircuitBreaker = {
  failures: 0,
  lastFailure: 0,
  state: 'closed',
  threshold: 5,
  resetTimeout: 60000,
  baseResetTimeout: 60000,
  maxResetTimeout: 1800000,
  halfOpenProbeLock: null,
};

// Exponential backoff for circuit breaker reset timeout.
// Doubles the reset timeout each full open cycle, capped at maxResetTimeout.
// Prevents rapid probing when a provider is down for extended periods.
export function __applyExponentialBackoff(cb: CircuitBreaker): void {
  cb.resetTimeout = Math.min(cb.resetTimeout * 2, cb.maxResetTimeout);
}

export function __resetBackoffToBase(cb: CircuitBreaker): void {
  cb.resetTimeout = cb.baseResetTimeout;
}

// ---------- Metrics hooks (lazily set to avoid circular imports) ----------

type MetricsHooks = {
  onRequestStart?: (model: string) => void;
  onRequestSuccess?: (model: string, durationSec: number, tokens: number) => void;
  onRequestFailure?: (model: string, status?: number) => void;
};

const metricsHooks = {} as MetricsHooks;

export function registerAIMetricsHooks(hooks: MetricsHooks): void {
  if (hooks.onRequestStart) metricsHooks.onRequestStart = hooks.onRequestStart;
  if (hooks.onRequestSuccess) metricsHooks.onRequestSuccess = hooks.onRequestSuccess;
  if (hooks.onRequestFailure) metricsHooks.onRequestFailure = hooks.onRequestFailure;
}

/**
 * Test-only: reset the circuit breaker to its initial closed state.
 * Use sparingly — the CB is a module-level singleton. Calling this from
 * production code would defeat the protection.
 */
export function __resetCircuitBreakerForTests(): void {
  __resetBackoffToBase(kimiCircuitBreaker);
  kimiCircuitBreaker.state = 'closed';
  kimiCircuitBreaker.failures = 0;
  kimiCircuitBreaker.lastFailure = 0;
  kimiCircuitBreaker.halfOpenProbeLock = null;
  kimiCircuitBreaker.halfOpenProbeLockedAt = undefined;
  clearReleaseProbe(kimiCircuitBreaker);
  __resetBackoffToBase(mistralCircuitBreaker);
  mistralCircuitBreaker.state = 'closed';
  mistralCircuitBreaker.failures = 0;
  mistralCircuitBreaker.lastFailure = 0;
  mistralCircuitBreaker.halfOpenProbeLock = null;
  mistralCircuitBreaker.halfOpenProbeLockedAt = undefined;
  clearReleaseProbe(mistralCircuitBreaker);
}

/**
 * Test-only: expose the circuit breaker singletons so tests can inspect and
 * manipulate probe-lock state (e.g. aging a lock past the stale TTL).
 */
export function __getBreakersForTests(): {
  kimiCircuitBreaker: CircuitBreaker;
  mistralCircuitBreaker: CircuitBreaker;
} {
  return { kimiCircuitBreaker, mistralCircuitBreaker };
}

/**
 * Test-only helper to advance the circuit breaker's sense of time so that
 * `Date.now() - lastFailure > resetTimeout` becomes true. This lets tests
 * exercise the half-open recovery path without waiting for real timeouts.
 */
export function __advanceCircuitBreakerTimeForTests(offsetMs: number): void {
  const target = Date.now() - offsetMs;
  kimiCircuitBreaker.lastFailure = target;
  mistralCircuitBreaker.lastFailure = target;
}

/**
 * Test-only helper to put a circuit breaker into half-open state.
 */
export function __setCircuitBreakerHalfOpenForTests(provider: 'kimi' | 'mistral'): void {
  const cb = provider === 'kimi' ? kimiCircuitBreaker : mistralCircuitBreaker;
  cb.state = 'half-open';
  cb.failures = 0;
  cb.halfOpenProbeLock = null;
  clearReleaseProbe(cb);
}

/**
 * Fast-fail check: returns true when ALL AI providers are circuit-broken
 * AND within their respective reset timeouts (not yet due for a probe).
 * When true, any call to generateWithMistral will fail immediately without
 * making network requests, preventing 150+ wasted API calls per job.
 */
export function areAllProvidersUnavailable(): boolean {
  function isEffectivelyDown(cb: CircuitBreaker): boolean {
    if (cb.state === 'closed') return false;
    if (cb.state === 'half-open') return false;
    return Date.now() - cb.lastFailure < cb.resetTimeout;
  }
  return (
    isEffectivelyDown(kimiCircuitBreaker) &&
    isEffectivelyDown(mistralCircuitBreaker)
  );
}

// ---------- Types ----------

interface MistralResponse {
  id?: string;
  object?: string;
  choices?: Array<{ message: { content: string }; finish_reason: string }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: { message: string };
}

/**
 * Check if the Mistral circuit breaker is currently open (and within reset timeout).
 * If the reset timeout has expired, transitions to half-open automatically.
 * Throws if the breaker is open, returns void if OK to proceed.
 * Exported for use by embeddings.ts which calls the Mistral embedding API
 * directly (not through callMistral).
 */
export function __checkMistralCircuitBreaker(): void {
  if (mistralCircuitBreaker.state === 'open') {
    if (Date.now() - mistralCircuitBreaker.lastFailure > mistralCircuitBreaker.resetTimeout) {
      mistralCircuitBreaker.state = 'half-open';
      mistralCircuitBreaker.failures = 0;
    } else {
      throw new Error('Mistral AI circuit breaker open - service temporarily unavailable');
    }
  }

  if (mistralCircuitBreaker.state === 'half-open') {
    try {
      acquireMistralHalfOpenProbe();
    } catch {
      throw new Error('Mistral AI circuit breaker probe already in flight - service temporarily unavailable');
    }
  }
}

/**
 * Record a Mistral embedding API failure in the circuit breaker,
 * and release the half-open probe lock if held.
 * Exported for use by embeddings.ts.
 */
export function __recordMistralEmbeddingFailure(): Promise<void> {
  mistralCircuitBreaker.failures += 1;
  mistralCircuitBreaker.lastFailure = Date.now();

  if (mistralCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(mistralCircuitBreaker);
    mistralCircuitBreaker.state = 'open';
    __applyExponentialBackoff(mistralCircuitBreaker);
  } else if (mistralCircuitBreaker.state === 'open') {
    releaseHalfOpenProbeLock(mistralCircuitBreaker);
  } else if (mistralCircuitBreaker.failures >= mistralCircuitBreaker.threshold) {
    mistralCircuitBreaker.state = 'open';
    mistralCircuitBreaker.halfOpenProbeLock = null;
    __applyExponentialBackoff(mistralCircuitBreaker);
  }
  return Promise.resolve();
}

/**
 * Record an embedding API success in the Mistral circuit breaker.
 * Resets failure count and closes the breaker.
 * Exported for use by embeddings.ts.
 */
export function __recordMistralEmbeddingSuccess(): void {
  if (mistralCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(mistralCircuitBreaker);
  }
  mistralCircuitBreaker.failures = 0;
  mistralCircuitBreaker.state = 'closed';
  mistralCircuitBreaker.halfOpenProbeLock = null;
  __resetBackoffToBase(mistralCircuitBreaker);
}

/**
 * Get the Mistral rate limiter instance. Exported so embeddings.ts can
 * await the same rate limiter that chat completions use, preventing
 * embedding calls from bypassing the rate budget during Mistral outages.
 */
const __mistralRateLimiter: SlidingWindowRateLimiter = mistralRateLimiter;

export { __mistralRateLimiter as mistralRateLimiter };

// ---------- Sanitization ----------


// ---------- Key validation ----------

/**
 * Check if the Kimi K3 API key is configured and valid.
 * Used for story blueprints, bibles, episodes, scenes, dialogue, and YouTube SEO.
 */
function isValidKimiApiKey(): boolean {
  const key = getKimiApiKey();
  if (!key) return false;
  if (isPlaceholder(key)) return false;
  return key.length > 10;
}

/**
 * Check if a valid Mistral AI API key is configured.
 */
function isValidMistralApiKey(): boolean {
  const key = getMistralApiKey();
  if (!key) return false;
  if (isPlaceholder(key)) return false;
  return key.length > 10;
}

/**
 * Type-safe helper to set the _releaseProbe on a CircuitBreaker.
 * Returns the stored function reference (or undefined).
 */
function getReleaseProbe(cb: CircuitBreaker): (() => void) | undefined {
  return (cb as unknown as { _releaseProbe?: () => void })._releaseProbe;
}
function setReleaseProbe(cb: CircuitBreaker, fn: () => void): void {
  (cb as unknown as { _releaseProbe: () => void })._releaseProbe = fn;
}
function clearReleaseProbe(cb: CircuitBreaker): void {
  delete (cb as unknown as { _releaseProbe?: () => void })._releaseProbe;
}

/**
 * Create a half-open probe lock for a circuit breaker.
 * Returns a release function that must be called when the probe completes
 * (success or failure). Uses AbortController as a safe promise-based mutex
 * that cannot leak: the AbortController's abort fires even if the resolve
 * function is garbage collected, releasing the lock.
 */
function createHalfOpenProbeLock(cb: CircuitBreaker): Promise<void> {
  if (cb.state !== 'half-open') {
    throw new Error('Circuit breaker not in half-open state');
  }
  // H3: Stale-lock TTL — if a previous probe never resolved (e.g. an
  // unrecorded throw path stranded it before the try/catch guard existed),
  // force-release after 2× the per-attempt timeout instead of wedging the
  // provider until process restart. The circuit is re-opened with backoff and
  // THIS call fails fast — the next call after the reset timeout probes cleanly.
  const STALE_PROBE_TTL_MS = 2 * 120_000;
  if (cb.halfOpenProbeLock !== null) {
    const lockedAt = cb.halfOpenProbeLockedAt ?? 0;
    if (Date.now() - lockedAt > STALE_PROBE_TTL_MS) {
      logger.warn({ lockedAt }, 'Circuit breaker half-open probe lock stale — force releasing');
      releaseHalfOpenProbeLock(cb);
      cb.state = 'open';
      cb.lastFailure = Date.now();
      __applyExponentialBackoff(cb);
      throw new Error('Circuit breaker open - service temporarily unavailable');
    } else {
      throw new Error('Circuit breaker probe already in flight');
    }
  }
  const ac = new AbortController();
  const lock = new Promise<void>((resolve) => {
    ac.signal.addEventListener('abort', () => {
      cb.halfOpenProbeLock = null;
      resolve();
    }, { once: true });
  });
  setReleaseProbe(cb, () => {
    cb.halfOpenProbeLock = null;
    ac.abort();
  });
  cb.halfOpenProbeLock = lock;
  cb.halfOpenProbeLockedAt = Date.now();
  return lock;
}

/** Release the half-open probe lock for a circuit breaker, if held. */
function releaseHalfOpenProbeLock(cb: CircuitBreaker): void {
  const release = getReleaseProbe(cb);
  if (release) {
    release();
  }
  clearReleaseProbe(cb);
  cb.halfOpenProbeLock = null;
  cb.halfOpenProbeLockedAt = undefined;
}

/**
 * H3: Release a stranded half-open probe after an unrecorded throw (e.g. a
 * pipeline abort that bypassed the record helpers). Re-opens the circuit so
 * the provider is probed again after backoff instead of wedging forever in
 * half-open with "probe already in flight" errors.
 */
function releaseStrandedProbe(cb: CircuitBreaker): void {
  if (cb.state === 'half-open' && cb.halfOpenProbeLock !== null) {
    releaseHalfOpenProbeLock(cb);
    cb.state = 'open';
    __applyExponentialBackoff(cb);
    logger.warn('Circuit breaker probe released after unrecorded throw — re-opened');
  }
}

/**
 * Acquire the half-open probe lock for Mistral AI circuit breaker.
 */
function acquireMistralHalfOpenProbe(): void {
  // H3: REGISTER the probe lock and return immediately. The previous code
  // returned the lock promise and callers awaited it — but that promise only
  // resolves when the probe is RELEASED (by the record helpers that run after
  // the awaited work), so every half-open probe deadlocked on the spot. This
  // is the production "circuit breaker lockup — requires container restart".
  createHalfOpenProbeLock(mistralCircuitBreaker);
}

function _mistralRecordFailure(): void {
  mistralCircuitBreaker.failures += 1;
  mistralCircuitBreaker.lastFailure = Date.now();
  if (mistralCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(mistralCircuitBreaker);
    mistralCircuitBreaker.state = 'open';
    __applyExponentialBackoff(mistralCircuitBreaker);
    logger.warn(
      { resetTimeout: mistralCircuitBreaker.resetTimeout },
      'Mistral AI circuit breaker reopened from half-open'
    );
    return;
  }
  if (mistralCircuitBreaker.failures >= mistralCircuitBreaker.threshold && mistralCircuitBreaker.state !== 'open') {
    mistralCircuitBreaker.state = 'open';
    mistralCircuitBreaker.halfOpenProbeLock = null;
    __applyExponentialBackoff(mistralCircuitBreaker);
    logger.warn(
      { resetTimeout: mistralCircuitBreaker.resetTimeout },
      'Mistral AI circuit breaker opened'
    );
  }
}

function _mistralRecordSuccess(): void {
  if (mistralCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(mistralCircuitBreaker);
  }
  mistralCircuitBreaker.failures = 0;
  mistralCircuitBreaker.state = 'closed';
  mistralCircuitBreaker.halfOpenProbeLock = null;
  __resetBackoffToBase(mistralCircuitBreaker);
}

/**
 * Acquire the half-open probe lock for Kimi K3 circuit breaker.
 * Same semantics as the Mistral version — Promise mutex ensures only one
 * request enters the probe slot at a time.
 */
function acquireKimiHalfOpenProbe(): void {
  // H3: REGISTER the probe lock and return immediately (see Mistral version).
  createHalfOpenProbeLock(kimiCircuitBreaker);
}

function _kimiRecordFailure(): void {
  kimiCircuitBreaker.failures += 1;
  kimiCircuitBreaker.lastFailure = Date.now();
  if (kimiCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(kimiCircuitBreaker);
    kimiCircuitBreaker.state = 'open';
    __applyExponentialBackoff(kimiCircuitBreaker);
    logger.warn({ resetTimeout: kimiCircuitBreaker.resetTimeout }, 'Kimi K3 circuit breaker reopened from half-open');
    return;
  }
  if (kimiCircuitBreaker.failures >= kimiCircuitBreaker.threshold && kimiCircuitBreaker.state !== 'open') {
    kimiCircuitBreaker.state = 'open';
    kimiCircuitBreaker.halfOpenProbeLock = null;
    __applyExponentialBackoff(kimiCircuitBreaker);
    logger.warn({ resetTimeout: kimiCircuitBreaker.resetTimeout }, 'Kimi K3 circuit breaker opened');
  }
}

function _kimiRecordSuccess(): void {
  if (kimiCircuitBreaker.state === 'half-open') {
    releaseHalfOpenProbeLock(kimiCircuitBreaker);
  }
  kimiCircuitBreaker.failures = 0;
  kimiCircuitBreaker.state = 'closed';
  kimiCircuitBreaker.halfOpenProbeLock = null;
  __resetBackoffToBase(kimiCircuitBreaker);
}

/**
 * Generate a chat completion using Mistral AI API.
 * Mistral AI is the primary provider for story generation.
 * Uses the OpenAI-compatible endpoint with Bearer auth.
 */
async function callMistral(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  if (!isValidMistralApiKey()) {
    throw new Error('Mistral AI API key not configured or is a placeholder.');
  }

  if (mistralCircuitBreaker.state === 'open') {
    if (Date.now() - mistralCircuitBreaker.lastFailure > mistralCircuitBreaker.resetTimeout) {
      mistralCircuitBreaker.state = 'half-open';
      mistralCircuitBreaker.failures = 0;
    } else {
      throw new Error('Mistral AI circuit breaker open - service temporarily unavailable');
    }
  }

  if (mistralCircuitBreaker.state === 'half-open') {
    try {
      acquireMistralHalfOpenProbe();
    } catch {
      throw new Error('Mistral AI circuit breaker probe already in flight - service temporarily unavailable');
    }
  }

  // H3: Any throw from here on that bypasses the record helpers (pipeline
  // abort, watchdog, unexpected error) must not strand the half-open probe
  // lock — releaseStrandedProbe frees it and re-opens the circuit.
  try {
  await __waitForRateLimit(mistralRateLimiter, 'Mistral AI (20 req/min)');

  const maxRetries = 2;
  const baseDelayMs = 1000;
  const callId = `mistral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callStartedAt = process.hrtime.bigint();
  const model = getMistralModel();
  const apiKey = getMistralApiKey();
  const baseUrl = getMistralBaseUrl();

  logger.info(
    {
      callId,
      jobId: getCurrentAIPipelineContext().jobId,
      model,
      systemPromptLen: systemPrompt.length,
      userPromptLen: userPrompt.length,
    },
    'MISTRAL_ATTEMPT'
  );

  emitRequestStart(model);

  const baseRoot = baseUrl.replace(/\/+$/, '').replace(/\/ai\/run\/?$/, '');
  const url = `${baseRoot}/chat/completions`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ATTEMPT_TIMEOUT_MS = 120_000;
    const wd = createWatchdogAbortController(ATTEMPT_TIMEOUT_MS, 'mistral_attempt');
    const attemptStartedAt = process.hrtime.bigint();

    // H4: Check pipeline abort before making the call
    checkPipelineAborted();

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options?.temperature ?? 0.75,
          max_tokens: options?.maxTokens ?? 8000,
        }),
        signal: combineAbortSignals(wd.controller.signal),
      });
      wd.cancel();
    } catch (err) {
      wd.cancel();
      const attemptMs = Number(process.hrtime.bigint() - attemptStartedAt) / 1_000_000;
      logger.warn(
        { callId, attempt: attempt + 1, elapsedMs: Math.round(attemptMs), err: String(err).slice(0, 200) },
        'MISTRAL_NETWORK_ERROR'
      );
      if (attempt < maxRetries - 1) {
        const delay = calculateDelay(baseDelayMs, attempt);
        await sleep(delay);
        continue;
      }
      _mistralRecordFailure();
      emitRequestFailure(model);
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      if (attempt < maxRetries - 1 && isRetriableStatus(status)) {
        const delay = calculateDelay(baseDelayMs, attempt);
        logger.warn({ callId, status, delayMs: Math.round(delay) }, 'Mistral AI HTTP error, retrying');
        await sleep(delay);
        continue;
      }
      _mistralRecordFailure();
      emitRequestFailure(model, status);
      const text = await response.text().catch(() => '');
      throw new Error(`Mistral AI API error: ${status} - ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as MistralResponse;

    if (data.error) {
      _mistralRecordFailure();
      emitRequestFailure(model);
      throw new Error(`Mistral AI error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      _mistralRecordFailure();
      emitRequestFailure(model, response.status);
      throw new Error('Invalid response structure from Mistral AI API');
    }

    const sanitized = sanitizeAIResponse(content);
    if (sanitized.length === 0) {
      if (attempt < maxRetries - 1) {
        const delay = calculateDelay(baseDelayMs, attempt);
        logger.warn(
          { callId, attempt: attempt + 1, delayMs: Math.round(delay) },
          'Mistral AI returned empty content — retrying'
        );
        await sleep(delay);
        continue;
      }
      _mistralRecordFailure();
      emitRequestFailure(model);
      throw new Error('Mistral AI returned empty content after all retries');
    }

    _mistralRecordSuccess();

    const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt);
    const completionTokens = data.usage?.completion_tokens ?? estimateTokens(content);
    await recordProviderUsage(promptTokens, completionTokens, 'mistral');

    const totalMs = Number(process.hrtime.bigint() - callStartedAt) / 1_000_000;
    const tokens = promptTokens + completionTokens;
    emitRequestSuccess(model, totalMs, tokens);
    logger.info(
      {
        callId,
        jobId: getCurrentAIPipelineContext().jobId,
        attemptsUsed: attempt + 1,
        totalMs: Math.round(totalMs),
        responseChars: sanitized.length,
        promptTokens,
        completionTokens,
      },
      'MISTRAL_CALL_COMPLETED'
    );

    return sanitized;
  }

  throw new Error('Mistral AI API failed after all retries');
  } catch (err) {
    releaseStrandedProbe(mistralCircuitBreaker);
    throw err;
  }
}

/**
 * Generate a chat completion using Kimi K3 (OpenAI-compatible endpoint).
 * Fallback provider for story blueprints, bibles, episodes, scenes, dialogue, and YouTube SEO.
 */
async function callKimi(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  if (!isValidKimiApiKey()) {
    throw new Error('Kimi K3 API key not configured or is a placeholder.');
  }

  if (kimiCircuitBreaker.state === 'open') {
    if (Date.now() - kimiCircuitBreaker.lastFailure > kimiCircuitBreaker.resetTimeout) {
      kimiCircuitBreaker.state = 'half-open';
      kimiCircuitBreaker.failures = 0;
    } else {
      throw new Error('Kimi K3 circuit breaker open - service temporarily unavailable');
    }
  }

  if (kimiCircuitBreaker.state === 'half-open') {
    try {
      acquireKimiHalfOpenProbe();
    } catch {
      throw new Error('Kimi K3 circuit breaker probe already in flight - service temporarily unavailable');
    }
  }

  // H3: Any throw from here on that bypasses the record helpers (pipeline
  // abort, watchdog, unexpected error) must not strand the half-open probe
  // lock — releaseStrandedProbe frees it and re-opens the circuit.
  try {
  await __waitForRateLimit(kimiRateLimiter, 'Kimi K3 (30 req/min)');

  const maxRetries = 2;
  const baseDelayMs = 1000;
  const callId = `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callStartedAt = process.hrtime.bigint();
  const model = getKimiModel();

  logger.info(
    { callId, jobId: getCurrentAIPipelineContext().jobId, model, systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length },
    'KIMI_ATTEMPT'
  );

  emitRequestStart(model);

  const url = getKimiBaseUrl();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ATTEMPT_TIMEOUT_MS = 120_000;
    const wd = createWatchdogAbortController(ATTEMPT_TIMEOUT_MS, 'kimi_attempt');
    const attemptStartedAt = process.hrtime.bigint();

    checkPipelineAborted();

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getKimiApiKey()}`,
        },
        body: JSON.stringify({
          model: getKimiModel(),
          messages,
          // M10: Honor the per-stage temperature passed by the caller instead of
          // hardcoding 1. Callers (e.g. generateWithMistral) forward a
          // stage-specific temperature; previously it was silently dropped.
          temperature: options?.temperature ?? 1,
          max_tokens: options?.maxTokens ?? 8000,
        }),
        signal: combineAbortSignals(wd.controller.signal),
      });
      wd.cancel();
    } catch (err) {
      wd.cancel();
      const attemptMs = Number(process.hrtime.bigint() - attemptStartedAt) / 1_000_000;
      logger.warn(
        { callId, attempt: attempt + 1, elapsedMs: Math.round(attemptMs), err: String(err).slice(0, 200) },
        'KIMI_NETWORK_ERROR'
      );
      if (attempt < maxRetries - 1) {
        const delay = calculateDelay(baseDelayMs, attempt);
        await sleep(delay);
        continue;
      }
      _kimiRecordFailure();
      emitRequestFailure(model);
      throw err;
    }

    if (!response.ok) {
      const status = response.status;
      if (attempt < maxRetries - 1 && isRetriableStatus(status)) {
        const delay = calculateDelay(baseDelayMs, attempt);
        logger.warn({ callId, status, delayMs: Math.round(delay) }, 'Kimi K3 HTTP error, retrying');
        await sleep(delay);
        continue;
      }
      _kimiRecordFailure();
      emitRequestFailure(model, status);
      const text = await response.text().catch(() => '');
      throw new Error(`Kimi K3 API error: ${status} - ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number }; error?: { message: string } };

    if (data.error) {
      _kimiRecordFailure();
      emitRequestFailure(model);
      throw new Error(`Kimi K3 error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      _kimiRecordFailure();
      emitRequestFailure(model, response.status);
      throw new Error('Invalid response structure from Kimi K3 API');
    }

    const sanitized = sanitizeAIResponse(content);
    if (sanitized.length === 0) {
      if (attempt < maxRetries - 1) {
        const delay = calculateDelay(baseDelayMs, attempt);
        logger.warn(
          { callId, attempt: attempt + 1, delayMs: Math.round(delay) },
          'Kimi K3 returned empty content — retrying'
        );
        await sleep(delay);
        continue;
      }
      _kimiRecordFailure();
      emitRequestFailure(model);
      throw new Error('Kimi K3 returned empty content after all retries');
    }

    _kimiRecordSuccess();

    const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt);
    const completionTokens = data.usage?.completion_tokens ?? estimateTokens(content);
    await recordProviderUsage(promptTokens, completionTokens, 'kimi');

    const totalMs = Number(process.hrtime.bigint() - callStartedAt) / 1_000_000;
    const tokens = promptTokens + completionTokens;
    emitRequestSuccess(model, totalMs, tokens);
    logger.info(
      {
        callId,
        jobId: getCurrentAIPipelineContext().jobId,
        attemptsUsed: attempt + 1,
        totalMs: Math.round(totalMs),
        responseChars: sanitized.length,
        promptTokens,
        completionTokens,
      },
      'KIMI_CALL_COMPLETED'
    );

    return sanitized;
  }

  throw new Error('Kimi K3 API failed after all retries');
  } catch (err) {
    releaseStrandedProbe(kimiCircuitBreaker);
    throw err;
  }
}

// ---------- Main API ----------

/**
 * Test-only helpers to enable/disable canned fallback on the CURRENT pipeline
 * context. These use the existing AsyncLocalStorage pipeline context so that
 * enabling canned mode on one pipeline does NOT affect concurrent pipelines.
 * Falls back to the module-level flag when no pipeline context is active.
 */
export function __enableCannedFallback(): void {
  const ctx = aiPipelineContext.getStore();
  if (ctx) {
    ctx.cannedFallbackEnabled = true;
  } else {
    throw new Error(
      '__enableCannedFallback() requires an active AI pipeline context. ' +
      'Wrap the test code in runWithAIPipelineContext() first.'
    );
  }
}
export function __disableCannedFallback(): void {
  const ctx = aiPipelineContext.getStore();
  if (ctx) {
    ctx.cannedFallbackEnabled = false;
  } else {
    throw new Error(
      '__disableCannedFallback() requires an active AI pipeline context. ' +
      'Wrap the test code in runWithAIPipelineContext() first.'
    );
  }
}

function isCannedFallbackActive(): boolean {
  const ctx = aiPipelineContext.getStore();
  return ctx ? ctx.cannedFallbackEnabled : false;
}

export async function generateWithMistral(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxTokens?: number; stage?: string }
): Promise<string> {
  if (isCannedMode() || isCannedFallbackActive()) {
    if (isCannedMode()) {
      logger.warn({ systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length }, 'STORY_TEST_MODE=canned: returning canned chat response');
    } else {
      logger.warn({ systemPromptLen: systemPrompt.length, userPromptLen: userPrompt.length }, 'E2E canned fallback enabled: returning canned chat response');
    }
    // L4-WORKER-METRICS: canned responses still count as AI requests from the
    // caller's perspective (the pipeline made an AI call and got a synthetic
    // response). Emit metrics so tests and dashboards see non-zero counters
    // even when STORY_TEST_MODE=canned is active.
    const model = getMistralModel();
    emitRequestStart(model);
    const startedAt = process.hrtime.bigint();
    const response = cannedChatResponse(systemPrompt, userPrompt);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    emitRequestSuccess(model, durationMs, estimateTokens(response));
    return response;
  }

  checkPipelineAborted();

  if (areAllProvidersUnavailable()) {
    throw new Error('All AI providers are currently unavailable (Mistral and Kimi K3 circuit breakers are open)');
  }

  const stage = options?.stage ?? 'content';

  if (stage === 'blueprint') {
    if (isValidMistralApiKey()) {
      try {
        return await callMistral(systemPrompt, userPrompt, options);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ err: msg.slice(0, 200) }, 'Mistral blueprint failed, falling back to Kimi for blueprint');
        if (!isValidKimiApiKey()) {
          throw e instanceof Error ? e : new Error(msg);
        }
      }
    }
    if (isValidKimiApiKey()) {
      return await callKimi(systemPrompt, userPrompt, options);
    }
    throw new Error('No AI provider available for blueprint generation. Configure MISTRAL_API_KEY or KIMI_API_KEY.');
  }

  if (isValidMistralApiKey()) {
    try {
      return await callMistral(systemPrompt, userPrompt, options);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: msg.slice(0, 200) }, 'Mistral content failed, falling back to Kimi for content');
      // If the only fallback (Kimi) isn't configured, propagate the real error
      // instead of masking it with a misleading "configure provider" message.
      if (!isValidKimiApiKey()) {
        throw e instanceof Error ? e : new Error(msg);
      }
    }
  }
  if (isValidKimiApiKey()) {
    return await callKimi(systemPrompt, userPrompt, options);
  }
  throw new Error('No AI provider available for content generation. Configure MISTRAL_API_KEY or KIMI_API_KEY.');
}

// ---------- YouTube SEO ----------

export async function generateYouTubeSEO(
  storyTitle: string,
  genre: string,
  protagonistName: string,
  episodeHook: string,
  episodeCount: number
): Promise<YouTubeSEO> {
  const systemPrompt = `You are a YouTube growth expert and viral content specialist. You help creators optimize their videos for maximum reach, engagement, and viral potential. Your expertise includes YouTube SEO, thumbnail design, algorithm optimization, and viral content strategies.`;

  const safeTitle = sanitizeForPrompt(storyTitle);
  const safeGenre = sanitizeForPrompt(genre);
  const safeProtagonist = sanitizeForPrompt(protagonistName);
  const safeHook = sanitizeForPrompt(episodeHook);

  const userPrompt = `Create YouTube SEO optimization for an original hand-painted storybook anime story video.

Story Details:
- Title: ${safeTitle}
- Genre: ${safeGenre}
- Main Character: ${safeProtagonist}
- Episode Hook: ${safeHook}
- Total Episodes: ${episodeCount}

RULES (must follow):
- Title MUST be ≤${YOUTUBE_TITLE_MAX_LENGTH} characters and contain at least one of: a number, an emotion word, or a power word (Secret/Hidden/Untold/Shocking/Revealed).
- Title MUST reflect the genre's distinct tone and setting — avoid generic templates that work for any genre. Use genre-specific imagery and vocabulary (e.g. "moonlit" for fantasy, "shadow" for horror, "woven" for romance).
- Description MUST land its hook in the first 125 characters (the YouTube preview cap).
- At least one tag MUST be a YouTube format tag (#shorts, #anime, #storytime).
- Tags ordered broad → narrow. No copyrighted-IP names anywhere.
- Hook script: ≤2 sentences, ≤25 words, ends on tension.
- CTA script: 1 line, action verb first, ≤15 words.

IMPORTANT: Return ONLY valid JSON. No markdown, no explanations, no thinking.

{
  "title": "Your YouTube title (max ${YOUTUBE_TITLE_MAX_LENGTH} chars)",
  "description": "Your description (150-300 chars, hook in first 125)",
  "tags": ["tag1", "tag2", "tag3"],
  "thumbnailSuggestions": ["suggestion1", "suggestion2", "suggestion3"],
  "videoTemplate": "template structure",
  "hookScript": "opening hook script",
  "algorithmBoostTips": ["tip1", "tip2", "tip3", "tip4", "tip5"],
  "viralPotential": 75,
  "recommendedDuration": "45-60 seconds",
  "targetAudience": "target audience description",
  "trendingKeywords": ["keyword1", "keyword2"],
  "ctaScript": "call to action script"
}`;

  try {
    const response = await generateWithMistral(systemPrompt, userPrompt, { stage: 'content' });
    // Use the robust JSON extractor so nested braces/brackets and leading/trailing
    // prose don't cause us to slice inside a JSON value. safeJsonParse sanitizes
    // the extracted text and falls back to throwing if the model didn't return
    // valid JSON — the catch below returns default SEO values.
    const parsed = safeJsonParse<Partial<YouTubeSEO>>(response);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Model response was not a JSON object');
    }
    return validateAndFillSEO(parsed, storyTitle, genre, episodeHook);
  } catch (err) {
    logger.warn({ err }, 'YouTube SEO generation failed, using defaults');
    return getDefaultYouTubeSEO(storyTitle, genre, episodeHook);
  }
}

function validateAndFillSEO(
  input: Partial<YouTubeSEO>,
  storyTitle: string,
  genre: string,
  episodeHook: string
): YouTubeSEO {
  const isStrArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');

  const asString = (v: unknown, fallback: string): string =>
    typeof v === 'string' ? v : fallback;

  function truncateAtWordBoundary(s: string, max: number): string {
    if (s.length <= max) return s;
    const truncated = s.slice(0, max + 1);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > 0 ? truncated.slice(0, lastSpace) : s.slice(0, max);
  }

  // BL-004: Enforce title rules from system prompt in code — title must contain
  // a power word, emotion word, or number to be click-worthy.
  const POWER_WORDS = ['secret', 'hidden', 'untold', 'shocking', 'revealed', 'forbidden', 'mysterious', 'lost', 'cursed', 'awakened'];
  const EMOTION_WORDS = ['heartwarming', 'tearjerking', 'thrilling', 'heartbreaking', 'breathtaking', 'emotional', 'intense', 'dark', 'hopeful', 'desperate'];
  let title = truncateAtWordBoundary(asString(input.title, `${storyTitle} | Original Animated Story`), YOUTUBE_TITLE_MAX_LENGTH);
  const titleLower = title.toLowerCase();
  const hasPowerWord = POWER_WORDS.some((w) => titleLower.includes(w));
  const hasEmotionWord = EMOTION_WORDS.some((w) => titleLower.includes(w));
  const hasNumber = /\d/.test(title);
  if (!hasPowerWord && !hasEmotionWord && !hasNumber) {
    // Prepend a power word to satisfy the rule
    title = truncateAtWordBoundary(`Secret ${title}`, YOUTUBE_TITLE_MAX_LENGTH);
  }

  // BL-004: Enforce description rules — hook must land in first 125 chars
  // and total length is 150-300 chars (per the prompt spec). The previous
  // implementation chopped the whole description to ≤125 chars, contradicting
  // the 150-300 spec and making the subsequent slice(0, 300) dead code.
  let description = asString(
    input.description,
    `Watch this magical ${genre} story in a warm hand-painted storybook anime style.`
  );
  description = description.slice(0, 300);
  if (description.length > 125) {
    // Truncate at the last sentence boundary within 125 chars so the hook
    // lands intact inside the first 125; if the first sentence is longer,
    // fall back to a word-boundary cut with an ellipsis.
    const window125 = description.slice(0, 125);
    const lastSentenceEnd = Math.max(
      window125.lastIndexOf('. '),
      window125.lastIndexOf('! '),
      window125.lastIndexOf('? ')
    );
    if (lastSentenceEnd < 60) {
      // First sentence runs past 125 chars — cut it at a word boundary so a
      // hook still lands inside the first 125 chars.
      description = `${truncateAtWordBoundary(description, 122)}...`;
    }
    // Otherwise a sentence break already lands within the first 125 — keep
    // the full (≤300 char) description intact.
  }

  return {
    title,
    description,
    tags: isStrArray(input.tags) ? input.tags.slice(0, 12) : getDefaultTags(genre),
    thumbnailSuggestions: isStrArray(input.thumbnailSuggestions)
      ? input.thumbnailSuggestions.slice(0, 3)
      : ['Character in scenic setting', 'Emotional moment scene', 'Story climax frame'],
    videoTemplate: asString(input.videoTemplate, '15s hook → 45s story → 5s CTA'),
    hookScript: asString(input.hookScript, episodeHook),
    algorithmBoostTips: isStrArray(input.algorithmBoostTips)
      ? input.algorithmBoostTips.slice(0, 5)
      : getDefaultAlgorithmTips(),
    viralPotential:
      typeof input.viralPotential === 'number'
        ? Math.min(100, Math.max(0, input.viralPotential))
        : 75,
    recommendedDuration: asString(input.recommendedDuration, '45-60 seconds'),
    targetAudience: asString(input.targetAudience, 'Anime and cozy fantasy fans'),
    trendingKeywords: isStrArray(input.trendingKeywords)
      ? input.trendingKeywords.slice(0, 8)
      : ['anime story', 'storybook animation', 'animated short'],
    ctaScript: asString(input.ctaScript, 'Like and subscribe for more magical stories!'),
  };
}

function getDefaultAlgorithmTips(): string[] {
  return [
    'Upload consistently at optimal times (2-4 PM local time)',
    'Use pins and engaging comments in first hour',
    'Create short clips for YouTube Shorts cross-promotion',
    'Add chapters for better watch time retention',
    'Engage with comments to boost algorithm ranking',
  ];
}

function getDefaultTags(genre: string): string[] {
  return [
    'anime story',
    'storybook animation',
    'animated short',
    'cozy fantasy',
    'wholesome',
    genre,
    'story time',
    'youtube short',
  ];
}

// BUG-005: exported so the worker's stage9_SEO can populate a default
// YouTubeSEO when the hard timeout fires before generateYouTubeSEO's inner
// catch can return the default itself.
//
// Fix #46: the returned object is marked with `isPlaceholder: true` so the
//   UI can show "Run SEO generation again to improve" rather than treating
//   the placeholder text as a real title. Without this flag, the user
//   might publish a story with the literal "Original Animated Story"
//   suffix in the title and never know it was a fallback.
export function getDefaultYouTubeSEO(storyTitle: string, genre: string, episodeHook: string): YouTubeSEO {
  return {
    title: `${storyTitle} | Original Animated Story`,
    description: `Watch this magical ${genre} story in a warm hand-painted storybook anime style. ${episodeHook}`,
    tags: getDefaultTags(genre),
    thumbnailSuggestions: [
      'Character in scenic setting',
      'Emotional moment scene',
      'Story climax frame',
    ],
    videoTemplate: '15s hook → 45s story → 5s CTA',
    hookScript: episodeHook,
    algorithmBoostTips: getDefaultAlgorithmTips(),
    viralPotential: 75,
    recommendedDuration: '45-60 seconds',
    targetAudience: 'Anime and cozy fantasy fans who love original story content',
    trendingKeywords: ['anime story', 'storybook animation', 'animated short', 'wholesome content'],
    ctaScript: 'Like and subscribe for more magical stories!',
    // Internal flag — not part of the YouTubeSEO domain type. The
    // `as unknown as YouTubeSEO` cast at the end of the function strips
    // it before the object leaves this module. Tests can detect the
    // marker via the type discriminator.
    isPlaceholder: true,
  } as YouTubeSEO & { isPlaceholder?: boolean };
}
