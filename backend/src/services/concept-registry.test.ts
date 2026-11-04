/**
 * Concept Registry Tests
 *
 * Covers:
 * - Claim-token extraction (significant title words, full name, name prefix)
 * - Atomic claim semantics (SET NX per token, same-job idempotency)
 * - Conflict detection across concurrent jobs + rollback of partial claims
 * - Fail-open behavior when Redis is unavailable
 * - Prompt formatting of claimed tokens
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// In-memory Redis stand-in honoring SET ... NX semantics.
const store = new Map<string, string>();
const mockRedis = {
  set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
    if (nx === 'NX' && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  del: vi.fn(async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n += 1;
    return n;
  }),
  scan: vi.fn(async (cursor: string, _match: string, pattern: string, _count: string, _n: number) => {
    const prefix = pattern.replace('*', '');
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys] as [string, string[]];
  }),
};

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => mockRedis,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('extractClaimTokens', () => {
  it('extracts significant title words, full name, and 3-char name prefix', async () => {
    const { extractClaimTokens } = await import('./concept-registry.js');
    const tokens = extractClaimTokens('The Silent Echo Chamber', 'Elis Moreau');
    expect(tokens).toContain('title:silent');
    expect(tokens).toContain('title:echo');
    expect(tokens).toContain('title:chamber');
    expect(tokens).toContain('name:elis moreau');
    expect(tokens).toContain('name-prefix:eli');
  });

  it('drops stopwords and short words', async () => {
    const { extractClaimTokens } = await import('./concept-registry.js');
    const tokens = extractClaimTokens('The War of the Ring', 'Al');
    expect(tokens).not.toContain('title:the');
    expect(tokens).not.toContain('title:of');
    expect(tokens).toContain('title:ring');
    expect(tokens).not.toContain('name:al');
  });
});

describe('claimConceptTokens', () => {
  it('claims tokens for the owner job and allows same-job re-claim', async () => {
    const { claimConceptTokens } = await import('./concept-registry.js');
    expect(await claimConceptTokens('job-a', ['title:echo'])).toEqual([]);
    expect(await claimConceptTokens('job-a', ['title:echo'])).toEqual([]);
  });

  it('detects conflicts from other jobs and rolls back partial claims', async () => {
    const { claimConceptTokens } = await import('./concept-registry.js');
    await claimConceptTokens('job-a', ['title:echo']);
    const conflicts = await claimConceptTokens('job-b', ['title:static', 'title:echo']);
    expect(conflicts).toEqual(['title:echo']);
    // 'title:static' must have been rolled back — job-b holds nothing.
    expect(store.has('concept-claim:title:static')).toBe(false);
    expect(store.get('concept-claim:title:echo')).toBe('job-a');
  });

  it('fails open when Redis throws', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    const { claimConceptTokens } = await import('./concept-registry.js');
    await expect(claimConceptTokens('job-a', ['title:echo'])).resolves.toEqual([]);
  });
});

describe('getClaimedConceptTokens + formatClaimedTokensForPrompt', () => {
  it('lists tokens claimed by other jobs only', async () => {
    const { claimConceptTokens, getClaimedConceptTokens } = await import('./concept-registry.js');
    await claimConceptTokens('job-a', ['title:echo']);
    await claimConceptTokens('job-b', ['title:static']);
    expect(await getClaimedConceptTokens('job-a')).toEqual(['title:static']);
    expect((await getClaimedConceptTokens('job-c')).sort()).toEqual(['title:echo', 'title:static']);
  });

  it('formats constraints grouped by token kind', async () => {
    const { formatClaimedTokensForPrompt } = await import('./concept-registry.js');
    const lines = formatClaimedTokensForPrompt(['title:echo', 'title:static', 'name-prefix:eli']);
    expect(lines.some((l) => l.includes('echo') && l.includes('static') && l.toLowerCase().includes('title words'))).toBe(true);
    expect(lines.some((l) => l.includes('eli') && l.includes('prefix'))).toBe(true);
  });
});
