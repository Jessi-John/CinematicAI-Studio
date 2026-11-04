/**
 * Provider-priority tests: Mistral is the PRIMARY story-generation provider and
 * Kimi the FALLBACK. The sibling ai-client.test.ts mocks Mistral as
 * unconfigured (getMistralApiKey: ''), so it only exercises the Kimi path. This
 * file complements it by toggling BOTH provider keys via a hoisted mutable and
 * asserting the dispatcher prefers Mistral and falls back to Kimi.
 *
 * URL shapes:
 *  - Mistral: `${getMistralBaseUrl()}/chat/completions` (OpenAI-compatible)
 *  - Kimi:    `getKimiBaseUrl()` (already a full chat/completions endpoint)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/token-budget.js', () => ({
  checkAndRecordTokenBudget: vi.fn().mockResolvedValue({ ok: true }),
}));

const MISTRAL_BASE = 'https://mistral.test/api';
const KIMI_URL = 'https://kimi.test/api/chat/completions';
const MISTRAL_URL = `${MISTRAL_BASE}/chat/completions`;

// Mutable key state, toggled per test. vi.hoisted so the env mock factory
// (hoisted above imports by vitest) can read them lazily at call time.
const keys = vi.hoisted(() => ({
  mistral: 'sk-mistral-valid-key-that-is-long-enough-for-tests',
  kimi: 'sk-kimi-valid-key-that-is-long-enough-for-tests',
}));

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getKimiApiKey: () => keys.kimi,
  getKimiBaseUrl: () => KIMI_URL,
  getKimiModel: () => 'k3',
  getMistralApiKey: () => keys.mistral,
  getMistralBaseUrl: () => MISTRAL_BASE,
  getMistralModel: () => 'mistral-medium-2508',
  isPlaceholder: () => false,
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

function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  };
}

function calledUrls(mockFetch: ReturnType<typeof vi.fn>): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

describe('provider priority: Mistral primary, Kimi fallback', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    keys.mistral = 'sk-mistral-valid-key-that-is-long-enough-for-tests';
    keys.kimi = 'sk-kimi-valid-key-that-is-long-enough-for-tests';
    // Fresh module per test => fresh circuit breakers and rate limiters.
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls Mistral first when both providers are configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('mistral-content'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const result = await generateWithMistral('system', 'user');
    expect(result).toBe('mistral-content');
    expect(calledUrls(mockFetch)).toEqual([MISTRAL_URL]);
  });

  it('falls back to Kimi when Mistral fails', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).startsWith(MISTRAL_BASE)) {
        return { ok: false, status: 503, text: async () => 'Service Unavailable' };
      }
      return okResponse('kimi-content');
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const result = await generateWithMistral('system', 'user');
    expect(result).toBe('kimi-content');
    const urls = calledUrls(mockFetch);
    // Mistral retried (2 attempts) before giving up, then Kimi succeeded.
    expect(urls.filter((u) => u.startsWith(MISTRAL_BASE)).length).toBe(2);
    expect(urls[urls.length - 1]).toBe(KIMI_URL);
  });

  it('uses Kimi directly when Mistral is not configured', async () => {
    keys.mistral = '';
    const mockFetch = vi.fn().mockResolvedValue(okResponse('kimi-content'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const result = await generateWithMistral('system', 'user');
    expect(result).toBe('kimi-content');
    expect(calledUrls(mockFetch)).toEqual([KIMI_URL]);
  });

  it('uses Mistral directly when Kimi is not configured', async () => {
    keys.kimi = '';
    const mockFetch = vi.fn().mockResolvedValue(okResponse('mistral-content'));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    const result = await generateWithMistral('system', 'user');
    expect(result).toBe('mistral-content');
    expect(calledUrls(mockFetch)).toEqual([MISTRAL_URL]);
  });

  it('throws before any fetch when neither provider is configured', async () => {
    keys.mistral = '';
    keys.kimi = '';
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { generateWithMistral, __resetCircuitBreakerForTests } = await import('./ai-client.js');
    __resetCircuitBreakerForTests();

    await expect(generateWithMistral('system', 'user')).rejects.toThrow(/No AI provider available/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
