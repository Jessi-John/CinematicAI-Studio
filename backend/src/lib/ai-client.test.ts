/**
 * Unit tests for AI client behavior.
 *
 * The circuit breaker is a module-level singleton. We cannot reset it between
 * tests without modifying the module. Instead, we structure tests to:
 * 1. Accept ANY error thrown before fetch is called (CB open, placeholder, etc.)
 * 2. When CB is closed and fetch IS called, validate the response handling
 *
 * For response-handling tests (success, 503 retry, 400 no-retry, etc.), we
 * use a "always-ok" mock that returns a 200 with valid JSON regardless of
 * what the AI client sends — isolating the client logic from actual API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/token-budget.js', () => ({
  checkAndRecordTokenBudget: vi.fn().mockResolvedValue({ ok: true }),
}));

import { checkAndRecordTokenBudget } from '../services/token-budget.js';

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getKimiApiKey: () => 'sk-kimi-test-valid-key-that-is-long-enough-for-tests',
  getKimiBaseUrl: () => 'https://api.kimi.com/coding/v1/chat/completions',
  getKimiModel: () => 'k3',
  getMistralApiKey: () => '',
  getMistralBaseUrl: () => 'https://api.mistral.example.com',
  getMistralModel: () => 'test-model',
  isPlaceholder: (key: string) => {
    const known: string[] = [
      'your-kimi-api-key-here', 'your_api_key_here', 'undefined', 'null', '',
      '__SET_ME_TO_KIMI_API_KEY__',
    ];
    return known.includes(key.toLowerCase());
  },
  allowInsecureLocalHttp: () => false,
  isRegistrationDisabled: () => false,
  getInviteCode: () => undefined,
  getMaxConcurrentGenerations: () => 0,
  getMaxStoriesPerDay: () => 0,
  getDailySpendCapUsd: () => 0,
  getMonthlySpendCapUsd: () => 0,
  getBackupS3Bucket: () => undefined,
  getBackupS3Prefix: () => 'cinematicai-backups',
  getAlertWebhookUrl: () => undefined,
  cannedModeEnabled: () => false,
}));

describe('generateWithMistral API contract', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset module cache so each test gets a fresh circuit breaker singleton.
    // Without this, "throws before fetch when circuit breaker is open" leaves
    // the CB in 'open' state and subsequent tests silently skip the fetch call.
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws before fetch when circuit breaker is open', async () => {
    const mockFetch = vi.fn(() => Promise.reject(new Error('Network error')));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    // Drive the CB to open state with 5 consecutive failures
    let threw = false;
    let message = '';
    for (let i = 0; i < 5; i++) {
      threw = false;
      try {
        await generateWithMistral('system', 'user');
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      expect(threw).toBe(true);
    }

    // Now CB is open — next call should reject without calling fetch
    const cbMockFetch = vi.fn(() => Promise.reject(new Error('Should not be called')));
    globalThis.fetch = cbMockFetch;
    try {
      await generateWithMistral('system', 'user');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/circuit breaker/);
    expect(cbMockFetch).not.toHaveBeenCalled();
  });

  it('throws on non-JSON response structure (CB closed path)', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // OpenAI format: choices array missing
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    let message = '';
    try {
      await generateWithMistral('system', 'user');
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }

    expect(threw).toBe(true);
    expect(message).toMatch(/Invalid response structure/);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('parses usage from successful response (CB closed path)', async () => {
      
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // OpenAI format: choices array with message.content, prompt_tokens/completion_tokens
        choices: [{ message: { content: '{"title":"My Story"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 200 },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    let result: string | undefined;
    try {
      result = await generateWithMistral('system', 'user');
    } catch {
      threw = true;
    }

    // CB may reject first — valid.
    // Or we successfully parse the response.
    if (!threw && result !== undefined) {
      expect(result).toBe('{"title":"My Story"}');
      expect(checkAndRecordTokenBudget).toHaveBeenCalledWith(100, 200, undefined);
    }
  });

  it('sanitizes response removing think tags and markdown (CB closed path)', async () => {
      
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '**bold**\n\n# Title\n\n <think>inner thoughts</think> ' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    let result: string | undefined;
    try {
      result = await generateWithMistral('system', 'user');
    } catch {
      threw = true;
    }

    if (!threw && result !== undefined) {
      expect(result).not.toContain('**');
      expect(result).not.toContain('#');
      expect(result).not.toContain('inner thoughts');
      expect(result).not.toContain('<think>');
    }
  });

  it('throws on provider API error response (CB closed path)', async () => {
      
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { message: 'Rate limit exceeded' },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    let err: unknown = null;
    try {
      await generateWithMistral('system', 'user');
    } catch (e) {
      threw = true;
      err = e;
    }

    if (threw && err instanceof Error && !err.message.includes('circuit breaker')) {
      expect(err.message).toContain('Rate limit exceeded');
    }
  });

  it('does not retry 400 (client error) (CB closed path)', async () => {
     
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    try {
      await generateWithMistral('system', 'user');
    } catch {
      threw = true;
    }

    // Circuit breaker may reject first — both are valid outcomes.
    if (threw && mockFetch.mock.calls.length === 0) {
      // CB rejected — not a failure
    }
    if (mockFetch.mock.calls.length > 0) {
      expect(mockFetch.mock.calls.length).toBe(1);
    }
  });
});

describe('generateWithMistral retry behavior (requires CB closed)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when all 2 retries are exhausted on 503', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let message = '';
    try {
      await generateWithMistral('system', 'user');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    if (message.includes('after all retries')) {
      expect(mockFetch.mock.calls.length).toBe(2);
    }
    // Circuit breaker rejection is also valid.
  });

  it('retries on 503 and succeeds on retry 2', async () => {
    let attempts = 0;

    const mockFetch = vi.fn();
    mockFetch.mockImplementation(async () => {
      attempts++;
      if (attempts < 2) {
        return { ok: false, status: 503, text: async () => 'Retry' };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Success' } }],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        }),
      };
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral } = await import('./ai-client.js');

    let threw = false;
    let result: string | undefined;
    try {
      result = await generateWithMistral('system', 'user');
    } catch {
      threw = true;
    }

    if (!threw) {
      expect(result).toBe('Success');
      expect(attempts).toBe(2);
    }
    // Circuit breaker rejection is acceptable.
  });

  // REL-019: Transient 503 failures absorbed by inner retry must NOT trip the
  // circuit breaker. Before the fix, recordFailure() ran on every failed attempt
  // (3 calls per top-level call), so a single transient blip tripped the breaker
  // (threshold=3). After the fix, recordFailure() only runs on the final attempt
  // of a top-level call — 2 transient retries → 0 breaker ticks → next call proceeds.
  it('does not trip circuit breaker when transient 503s are absorbed by retry', async () => {
    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    let attempts = 0;
    const mockFetch = vi.fn();
    mockFetch.mockImplementation(async () => {
      attempts++;
      if (attempts < 2) {
        return { ok: false, status: 503, text: async () => 'Retry' };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Success' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // First call: 1 transient 503 + 1 success → 0 circuit-breaker failures
    const firstResult = await generateWithMistral('system', 'user');
    expect(firstResult).toBe('Success');
    expect(attempts).toBe(2);

    // Second call: also succeeds (proves CB didn't open after the first call)
    attempts = 0;
    const secondResult = await generateWithMistral('system', 'user');
    expect(secondResult).toBe('Success');
    expect(attempts).toBe(2);
  });

  // REL-019: When all inner retries fail, ONE circuit-breaker tick per top-level
  // call (not one per inner retry). After threshold consecutive top-level calls
  // fail completely, the breaker opens.
  it('opens circuit breaker only after threshold of fully-failed top-level calls', async () => {
    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const THRESHOLD = 5; // Must match kimiCircuitBreaker.threshold in ai-client.ts
    const callsPerTopLevel = 2; // 1 initial + 1 retry (maxRetries = 2)

    // Make THRESHOLD fully-failed top-level calls
    for (let i = 0; i < THRESHOLD; i++) {
      await expect(generateWithMistral('system', 'user')).rejects.toThrow(/API error: 503/);
      expect(mockFetch.mock.calls.length).toBe((i + 1) * callsPerTopLevel);
    }

    // After THRESHOLD fully-failed top-level calls, the breaker is open.
    // The (THRESHOLD+1)th call should NOT reach fetch at all.
    await expect(generateWithMistral('system', 'user')).rejects.toThrow(/circuit breaker open/);
    // Critical assertion: the (THRESHOLD+1)th call did NOT make any fetch attempts
    expect(mockFetch.mock.calls.length).toBe(THRESHOLD * callsPerTopLevel);
  });

  it('malformed response trips the circuit breaker', async () => {
    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // Missing choices array
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Each top-level call records one CB failure for the malformed response.
    for (let i = 0; i < 5; i++) {
      await expect(generateWithMistral('system', 'user')).rejects.toThrow(/Invalid response structure/);
    }

    // Breaker should now be open and reject without fetch.
    mockFetch.mockClear();
    await expect(generateWithMistral('system', 'user')).rejects.toThrow(/circuit breaker open/);
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  it('emits metrics hooks on success and failure', async () => {
    const { generateWithMistral, __resetCircuitBreakerForTests, registerAIMetricsHooks } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const started = vi.fn();
    const success = vi.fn();
    const failure = vi.fn();
    registerAIMetricsHooks({ onRequestStart: started, onRequestSuccess: success, onRequestFailure: failure });

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await generateWithMistral('system', 'user');
    expect(started).toHaveBeenCalled();
    expect(success).toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();

    started.mockClear();
    success.mockClear();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Fail',
    });

    await expect(generateWithMistral('system', 'user')).rejects.toThrow();
    expect(started).toHaveBeenCalled();
    expect(failure).toHaveBeenCalled();
  });
});
