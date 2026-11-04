/**
 * H5 regression tests — HTTPS webhook delivery must not break TLS via DNS pinning.
 *
 * Root cause: callWebhook pinned the resolved IP by REWRITING the URL hostname
 * (https://example.com → https://93.184.216.34) and setting a Host header. The
 * TLS handshake then presented the IP as SNI and validated the certificate
 * against the IP, so every HTTPS webhook (whose cert is issued for the domain)
 * failed certificate validation and was undeliverable.
 *
 * The fix keeps the original hostname in the URL (TLS SNI + cert validation use
 * the domain) and pins only the TCP dial target via an undici Agent with a
 * custom connector lookup — preserving the M4 TOCTOU-DNS-rebind protection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const undiciFetchMock = vi.fn();
const agentCloseMock = vi.fn();
const AgentMock = vi.fn();
let capturedLookup:
  | ((hostname: string, options: unknown, callback: (err: Error | null, address?: string, family?: number) => void) => void)
  | undefined;

vi.mock('undici', () => ({
  Agent: AgentMock,
  fetch: (...a: unknown[]) => undiciFetchMock(...a),
}));

// Mock ONLY node:dns/promises (which isUrlBlocked uses). We deliberately do
// NOT mock node:dns — mocking both the parent (node:dns) and child
// (node:dns/promises) together causes vitest's registry to clobber the
// promises binding, silently disabling this mock. The node:dns callback
// fallback in buildPinnedDispatcher is only exercised for non-target hosts
// (defensive; redirects are disabled), so it is not load-bearing here.
const dnsPromisesLookup = vi.fn();
vi.mock('node:dns/promises', () => ({
  default: { lookup: (...a: unknown[]) => dnsPromisesLookup(...a) },
  lookup: (...a: unknown[]) => dnsPromisesLookup(...a),
}));

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getApiSecret: vi.fn(() => 'test-api-secret'),
}));
vi.mock('../lib/retry.js', () => ({
  isRetriableStatus: vi.fn(() => false),
  isRetriableError: vi.fn(() => false),
  calculateDelay: vi.fn(() => 0),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));
vi.mock('../lib/sleep.js', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
const dlqAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../queue/index.js', () => ({ getStoryDlq: () => ({ add: dlqAdd }) }));

const PAYLOAD = { event: 'complete' as const, storyId: 's1', jobId: 'j1', timestamp: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  capturedLookup = undefined;
  // Set ALL implementations AFTER clearAllMocks — vitest clears factory-set
  // implementations, so anything assigned in the vi.mock factory is lost.
  // Use a `function` (not arrow) so the implementation is invoked under `new`.
  AgentMock.mockImplementation(function (this: unknown, opts: { connect?: { lookup?: unknown } }) {
    capturedLookup = opts?.connect?.lookup as typeof capturedLookup;
    return { close: agentCloseMock };
  });
  agentCloseMock.mockResolvedValue(undefined);
  dnsPromisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  undiciFetchMock.mockResolvedValue({ status: 200 });
});

describe('callWebhook — H5 TLS preservation', () => {
  it('fetches the ORIGINAL hostname URL (not the pinned IP) so TLS cert validation works', async () => {
    const { callWebhook } = await import('./webhook.js');
    await callWebhook('https://example.com/webhook', PAYLOAD);

    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = undiciFetchMock.mock.calls[0]!;
    // The hostname must be intact — the old code rewrote it to the IP.
    expect(calledUrl).toBe('https://example.com/webhook');
    expect(String(calledUrl)).not.toContain('93.184.216.34');
    // The request carries no manual Host header override (fetch sets it from the URL).
    const headers = (init as { headers?: Record<string, string> }).headers ?? {};
    expect(headers.Host).not.toBeDefined();
    // A pinned dispatcher IS attached for TOCTOU protection.
    expect((init as { dispatcher?: unknown }).dispatcher).not.toBeUndefined();
  });

  it('pins the TCP dial target to the pre-validated IP via the dispatcher lookup', async () => {
    const { callWebhook } = await import('./webhook.js');
    await callWebhook('https://example.com/webhook', PAYLOAD);

    expect(capturedLookup).not.toBeUndefined();
    const result = await new Promise<{ address?: string | undefined; family?: number | undefined }>((resolve) => {
      capturedLookup!('example.com', {}, (_err, address, family) => resolve({ address, family }));
    });
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('lookup is case-insensitive when matching the pinned host', async () => {
    const { callWebhook } = await import('./webhook.js');
    await callWebhook('https://example.com/webhook', PAYLOAD);

    // Case-insensitive match on the pinned host.
    const upper = await new Promise<{ address?: string | undefined }>((resolve) => {
      capturedLookup!('EXAMPLE.COM', {}, (_err, address) => resolve({ address }));
    });
    expect(upper.address).toBe('93.184.216.34');
  });

  it('closes the pinned dispatcher after delivery (no socket leak)', async () => {
    const { callWebhook } = await import('./webhook.js');
    await callWebhook('https://example.com/webhook', PAYLOAD);
    expect(agentCloseMock).toHaveBeenCalled();
  });

  it('still blocks SSRF targets before any fetch', async () => {
    const { callWebhook } = await import('./webhook.js');
    await callWebhook('http://127.0.0.1/webhook', PAYLOAD);
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(dlqAdd).toHaveBeenCalled();
  });
});
