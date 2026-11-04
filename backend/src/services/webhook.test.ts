/**
 * Unit tests for webhook URL blocklist (SSRF prevention).
 * Verifies that isUrlBlocked() correctly rejects internal/blocked addresses.
 */

import { describe, it, expect, vi } from 'vitest';

const mockDnsLookup = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: mockDnsLookup,
  },
}));

describe('webhook URL blocklist', () => {
  let isUrlBlocked: (url: string) => Promise<{ blocked: boolean; resolvedIp?: string }>;

  beforeAll(async () => {
    const mod = await import('./webhook.js');
    isUrlBlocked = mod.isUrlBlocked;
  });

  beforeEach(() => {
    mockDnsLookup.mockReset();
    mockDnsLookup.mockResolvedValue([]);
  });

  const blocklistUrls = [
    'http://localhost:1234/callback',
    'http://127.0.0.1:1234/callback',
    'http://0.0.0.0:1234/callback',
    'http://[::1]:1234/callback',
    'https://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://127.0.0.1:8080/admin',
  ];

  it.each(blocklistUrls)('blocks URL: %s', async (url) => {
    expect((await isUrlBlocked(url)).blocked).toBe(true);
  });

  const allowlistCases = [
    'https://webhook.example.com/callback',
    'https://api.production.com/v1/webhook',
    'https://hooks.slack.com/services/ABC123',
    'https://discord.com/api/webhooks/123456',
  ] as const;

  it.each(allowlistCases)('allows URL: %s', async (url) => {
    expect((await isUrlBlocked(url)).blocked).toBe(false);
  });

  it('blocks malformed URL as safety default', async () => {
    expect((await isUrlBlocked('not-a-valid-url')).blocked).toBe(true);
    expect((await isUrlBlocked('')).blocked).toBe(true);
    expect((await isUrlBlocked('http://')).blocked).toBe(true);
  });

  it('blocks URLs with credentials in hostname (but URL host must be the blocked address)', async () => {
    expect((await isUrlBlocked('http://localhost@evil.com/')).blocked).toBe(false);
    expect((await isUrlBlocked('http://127.0.0.1@evil.com/')).blocked).toBe(false);
  });

  it('blocks URLs with port on blocked host', async () => {
    expect((await isUrlBlocked('http://localhost:443/callback')).blocked).toBe(true);
    expect((await isUrlBlocked('http://127.0.0.1:8080/api')).blocked).toBe(true);
    expect((await isUrlBlocked('http://localhost:9000/webhook')).blocked).toBe(true);
  });

  it('blocks 0x7f000001 (hex-encoded 127.0.0.1)', async () => {
    const url = 'http://0x7f000001:8080/callback';
    expect((await isUrlBlocked(url)).blocked).toBe(true);
  });

  it('blocks integer-encoded 127.0.0.1 (2130706433)', async () => {
    const url = 'http://2130706433:8080/callback';
    expect((await isUrlBlocked(url)).blocked).toBe(true);
  });

  it('blocks IPv6 loopback variants', async () => {
    expect((await isUrlBlocked('http://[::1]:8080/')).blocked).toBe(true);
    // H10: the unspecified address is reserved space — block it, never connect.
    expect((await isUrlBlocked('http://[::]/')).blocked).toBe(true);
  });

  it('H10: blocks IPv4-mapped IPv6 literals (dotted and WHATWG-URL hex forms)', async () => {
    // Dotted-quad mapped forms
    expect((await isUrlBlocked('http://[::ffff:10.0.0.1]/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://[::ffff:192.168.1.1]/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://[::ffff:169.254.169.254]/latest/meta-data')).blocked).toBe(true);
    expect((await isUrlBlocked('http://[::ffff:127.0.0.1]/')).blocked).toBe(true);
    // Hex mapped form (::ffff:0a00:0001 = 10.0.0.1)
    expect((await isUrlBlocked('http://[::ffff:0a00:0001]/')).blocked).toBe(true);
    // Hex compressed form the WHATWG URL parser itself produces (10.0.0.1 → ::ffff:a00:1)
    expect((await isUrlBlocked('http://[::ffff:a00:1]/')).blocked).toBe(true);
    // Link-local variants across the whole fe80::/10 range
    expect((await isUrlBlocked('http://[fe85::1]/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://[febf::1]/')).blocked).toBe(true);
    // Public IPv4-mapped IPv6 must still be allowed
    expect((await isUrlBlocked('http://[::ffff:8.8.8.8]/')).blocked).toBe(false);
  });

  it('blocks private RFC1918 ranges — SSRF prevention', async () => {
    expect((await isUrlBlocked('http://10.0.0.1/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://192.168.1.1/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://172.16.0.1/')).blocked).toBe(true);
  });

  it('blocks file:// and other non-HTTP schemes', async () => {
    expect((await isUrlBlocked('file:///etc/passwd')).blocked).toBe(true);
    expect((await isUrlBlocked('gopher://localhost:11211/')).blocked).toBe(true);
    expect((await isUrlBlocked('ftp://internal-server/')).blocked).toBe(true);
  });

  it('blocks subdomains of blocked hosts (not hosts that merely start with the prefix)', async () => {
    expect((await isUrlBlocked('http://x.metadata.google.internal/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://metadata.google.internal/')).blocked).toBe(true);
    expect((await isUrlBlocked('http://metadata.google.internal.something.com/')).blocked).toBe(false);
  });

  it('blocks domain that DNS-resolves to loopback (DNS rebind protection)', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect((await isUrlBlocked('http://evil-rebind.com/callback')).blocked).toBe(true);
  });

  it('blocks domain that DNS-resolves to RFC1918 private IP', async () => {
    mockDnsLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    expect((await isUrlBlocked('http://vpc-internal.service/callback')).blocked).toBe(true);
  });

  it('blocks domain that DNS-resolution fails', async () => {
    mockDnsLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect((await isUrlBlocked('http://nonexistent.example.com/callback')).blocked).toBe(true);
  });
});