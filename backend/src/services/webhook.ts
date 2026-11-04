/**
 * Webhook dispatch service.
 *
 * Delivers webhook payloads to user-configured URLs with:
 * - HMAC-SHA256 signature using a webhook-specific derived key (not API_SECRET)
 * - 3 retries with exponential backoff
 * - Non-retriable error detection (4xx)
 * - Structured logging of all attempt/outcome events
 */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import net from 'node:net';
import { URL } from 'node:url';
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { getApiSecret } from '../config/env.js';
import { isRetriableStatus, isRetriableError, calculateDelay } from '../lib/retry.js';
import { logger } from './logger.js';
import { sleep } from '../lib/sleep.js';
import { getStoryDlq, type DlqEntry } from '../queue/index.js';

export interface WebhookPayload {
  event: 'complete' | 'error';
  storyId: string;
  jobId: string;
  genre?: string[];
  data?: unknown;
  timestamp: string;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;

// Comprehensive SSRF prevention via webhook callbacks.
// These IP ranges and hostnames must never be reachable from within the worker.
export const WEBHOOK_URL_BLOCKLIST = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',   // AWS metadata
  'metadata.google.internal', // GCP metadata
  'metadata.internal',        // Azure metadata
] as const;

// All private, reserved, and internal IPv4 ranges that must be blocked for SSRF.
// Prefix is the integer value of the leftmost `mask` bits of the network address.
// Each prefix is the network address right-shifted by (32 - mask) bits.
// This ensures the match works as: (addr >>> (32 - mask)) === prefix.
const BLOCKED_IPV4_RANGES = [
  { prefix: 0 >>> 24, mask: 8 },                                     // 0.0.0.0/8
  { prefix: (10 << 24) >>> 24, mask: 8 },                            // 10.0.0.0/8
  { prefix: ((100 << 24) | (64 << 16)) >>> 22, mask: 10 },          // 100.64.0.0/10
  { prefix: (127 << 24) >>> 24, mask: 8 },                           // 127.0.0.0/8
  { prefix: ((169 << 24) | (254 << 16)) >>> 16, mask: 16 },         // 169.254.0.0/16
  { prefix: ((172 << 24) | (16 << 16)) >>> 20, mask: 12 },          // 172.16.0.0/12
  { prefix: ((192 << 24) | (168 << 16)) >>> 16, mask: 16 },         // 192.168.0.0/16
  { prefix: ((198 << 24) | (18 << 16)) >>> 17, mask: 15 },          // 198.18.0.0/15
  { prefix: (240 << 24) >>> 28, mask: 4 },                           // 240.0.0.0/4
  { prefix: -1 >>> 0, mask: 32 },                                    // 255.255.255.255/32
];

// Single-label hostnames (no dots) resolve to Docker DNS / internal services.
// Block them to prevent SSRF against internal service names.
const SINGLE_LABEL_HOSTNAME = /^[a-zA-Z][a-zA-Z0-9-]+$/;

function ip4ToInt(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped/compatible IPv6 form.
 * Handles BOTH representations: dotted-quad (`::ffff:10.0.0.1`) and the
 * WHATWG-URL hex serialization (`::ffff:a00:1`) that `new URL()` produces —
 * the latter is why the previous string-prefix checks never fired (H10).
 */
function ipv4FromMappedV6(normalized: string): string | null {
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1]!;
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // IPv4-compatible form (`::a00:1`) — the 96-bit prefix is all zeros, so any
  // two-group `::x:y` beyond ::1 is reserved space and safe to treat as v4.
  const hexCompat = normalized.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexCompat) {
    const hi = parseInt(hexCompat[1]!, 16);
    const lo = parseInt(hexCompat[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

function isIpBlocked(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // Block loopback (::1) and the unspecified address (::)
    if (normalized === '::1' || normalized === '::') return true;
    // IPv4-mapped/compatible IPv6 — delegate to the full IPv4 range table so
    // ::ffff:10.x, ::ffff:192.168.x, ::ffff:169.254.169.254, hex forms, and
    // ::ffff:127.x are ALL blocked (H10).
    const mapped = ipv4FromMappedV6(normalized);
    if (mapped !== null) return isIpBlocked(mapped);
    // Block link-local (fe80::/10 = fe80–febf)
    if (/^fe[89ab]/.test(normalized)) return true;
    // Block unique local address (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // Block documentation (2001:db8::/32)
    if (normalized.startsWith('2001:db8')) return true;
    return false;
  }
  if (!net.isIPv4(ip)) return true; // unknown address family — block
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4) return true;
  const addr = ip4ToInt(octets);
  return BLOCKED_IPV4_RANGES.some((r) => {
    return (addr >>> (32 - r.mask)) === r.prefix;
  });
}


/**
 * M27: never log full webhook URLs — Slack/Discord/generic webhook URLs
 * embed secret path tokens that would land in log files in cleartext.
 * Log only the host.
 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable-url';
  }
}

export async function isUrlBlocked(url: string): Promise<{ blocked: boolean; resolvedIp?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true };
  }

  const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { blocked: true };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host.length === 0) return { blocked: true };

  // Static blocklist check — block exact host and any subdomain of it.
  const blockedByPattern = (WEBHOOK_URL_BLOCKLIST as readonly string[]).some((blocked) => {
    if (host === blocked) return true;
    if (host.endsWith(`.${blocked}`)) return true;
    return false;
  });
  if (blockedByPattern) return { blocked: true };

  // Single-label hostnames (e.g., "postgres", "redis") resolve to Docker DNS
  // or internal services. Block them unconditionally — legitimate webhook
  // targets always use a fully-qualified domain name.
  if (!host.includes('.') && !net.isIP(host) && SINGLE_LABEL_HOSTNAME.test(host)) {
    return { blocked: true };
  }

  // Block raw IPv4/IPv6 addresses that fall in private/reserved ranges
  if (net.isIP(host) && isIpBlocked(host)) {
    return { blocked: true };
  }

  // DNS rebind protection: resolve hostname and check resolved IP against all
  // blocked ranges. This catches domains that DNS-churn to internal addresses
  // at attack time (e.g., evil.com → 10.0.0.1).
  if (!net.isIP(host)) {
    try {
      const addresses = await dns.lookup(host, { all: true });
      if (addresses.some((addr) => isIpBlocked(addr.address))) {
        return { blocked: true };
      }
      const resolvedIp = addresses[0]?.address;
      return { blocked: false, ...(resolvedIp ? { resolvedIp } : {}) };
    } catch {
      return { blocked: true };
    }
  }

  return { blocked: false };
}

function signPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * H5 FIX: Build an undici dispatcher whose DNS lookup is pinned to a single
 * pre-validated IP for ONE hostname, WITHOUT rewriting the URL.
 *
 * Why not pin the IP into the URL (the old approach)? Replacing the hostname
 * with the resolved IP made the TLS handshake present the IP as the SNI and
 * validate the server certificate against the IP. Real certificates are issued
 * for the domain, so every HTTPS webhook failed certificate validation and was
 * undeliverable.
 *
 * Instead we keep the original hostname in the URL (so TLS SNI + certificate
 * validation use the domain) and only pin the TCP dial target via a custom
 * connector `lookup`. This preserves the M4 TOCTOU-DNS-rebind protection — the
 * connection always goes to the IP that passed the SSRF blocklist — while
 * leaving TLS intact. Any other hostname falls back to normal resolution
 * (defensive; redirects are disabled so this should never be exercised).
 */
function buildPinnedDispatcher(pinnedHost: string, pinnedIp: string): Dispatcher {
  const family = net.isIPv6(pinnedIp) ? 6 : 4;
  const hostLower = pinnedHost.toLowerCase();
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        if (hostname.toLowerCase() === hostLower) {
          callback(null, pinnedIp, family);
          return;
        }
        dnsLookupCb(hostname, options, callback);
      },
    },
  });
}

/**
 * Deliver a webhook payload to the given URL. Retries up to MAX_ATTEMPTS
 * on retriable errors (5xx, 429, network failures). 4xx errors are permanent
 * failures and are not retried.
 *
 * Uses an iterative loop instead of recursion so the call stack does not
 * grow with each retry, making the function easier to unit-test and reason
 * about (no hidden tail-call optimization dependency).
 */
export async function callWebhook(
  url: string,
  payload: WebhookPayload
): Promise<void> {
  // Block SSRF: reject webhooks pointing to internal/blocked addresses.
  // M4: isUrlBlocked now returns the resolved IP so we can pin it for the
  // fetch call, preventing a TOCTOU DNS rebind where the domain re-resolves
  // to 127.0.0.1 between the check and the fetch.
  const urlCheck = await isUrlBlocked(url);
  if (urlCheck.blocked) {
    logger.warn({ url: urlHost(url) }, 'Webhook URL blocklisted — rejecting delivery');
    await enqueueWebhookDlq(payload, url, 'URL blocklisted (SSRF prevention)');
    return;
  }

  // M4/H5: Pin DNS to the pre-validated IP via a custom dispatcher. The URL
  // keeps its original hostname so TLS SNI and certificate validation use the
  // domain — only the TCP dial target is pinned. This prevents a TOCTOU DNS
  // rebind (domain re-resolving to an internal IP between the blocklist check
  // and the fetch) WITHOUT breaking HTTPS certificate validation.
  let dispatcher: Dispatcher | undefined;
  if (urlCheck.resolvedIp) {
    try {
      const parsed = new URL(url);
      dispatcher = buildPinnedDispatcher(parsed.hostname, urlCheck.resolvedIp);
    } catch {
      // If URL parsing fails, proceed without pinning (the blocklist check
      // already passed; this is a defensive fallback).
      dispatcher = undefined;
    }
  }

  // INT-002: Derive a webhook-specific signing key from API_SECRET.
  // This ensures that if the webhook signing key is compromised, the SSE HMAC
  // key (used for real-time auth) is not affected. We use a separate derived
  // key for each security domain.
  const apiSecret = getApiSecret();
  const webhookSecret = crypto.createHash('sha256').update(apiSecret + ':webhook-signing').digest('hex');

  // Iterative retry loop — replaces previous recursive callWebhook(url, payload, attempt+1)
  // pattern to avoid stack depth growth on retries. Wrapped in try/finally so the
  // pinned dispatcher is closed on every return path (all loop exits are returns).
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body = JSON.stringify(payload);
      const signature = signPayload(body, webhookSecret);

      let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;

      try {
        // H5: fetch the ORIGINAL url (hostname intact → TLS SNI and certificate
        // validation use the domain). The pinned dispatcher only overrides the
        // TCP dial target; it never rewrites the request URL or Host header.
        // undici's fetch is used so the dispatcher type matches the Agent.
        const init: UndiciRequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CinematicAI-Signature': signature,
            'X-CinematicAI-Event': payload.event,
            'X-CinematicAI-Timestamp': payload.timestamp,
          },
          body,
          signal: AbortSignal.timeout(10_000),
          // MEDIUM #30: Do not follow HTTP redirects. An allowed external URL
          // that returns a 302/307 to an internal/blocked host would otherwise
          // bypass the SSRF DNS/IP pinning above.
          redirect: 'error',
        };
        if (dispatcher) init.dispatcher = dispatcher;
        response = await undiciFetch(url, init);
      } catch (err) {
        // Network-level failure — retry if we have attempts left
        if (attempt < MAX_ATTEMPTS && isRetriableError(err)) {
          logger.warn({ url: urlHost(url), attempt, maxAttempts: MAX_ATTEMPTS, err }, 'Webhook network error, retrying');
          const delay = calculateDelay(BASE_DELAY_MS, attempt);
          await sleep(delay);
          continue;
        }
        logger.error({ url: urlHost(url), attempt, err }, 'Webhook delivery permanently failed after network error');
        await enqueueWebhookDlq(payload, url, String(err));
        return;
      }

      const status = response.status;

      if (status >= 200 && status < 300) {
        logger.info(
          { url: urlHost(url), event: payload.event, storyId: payload.storyId, attempt },
          'Webhook delivered successfully'
        );
        return;
      }

      // 4xx errors are non-retriable — log and exit
      if (status >= 400 && status < 500) {
        logger.warn(
          { url: urlHost(url), status, event: payload.event, storyId: payload.storyId },
          'Webhook rejected by target (4xx), not retrying'
        );
        await enqueueWebhookDlq(payload, url, `HTTP ${status}`);
        return;
      }

      // 5xx and 429 are retriable
      if (isRetriableStatus(status)) {
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(
            { url: urlHost(url), status, attempt, maxAttempts: MAX_ATTEMPTS },
            'Webhook server error, retrying'
          );
          const delay = calculateDelay(BASE_DELAY_MS, attempt);
          await sleep(delay);
          continue;
        }
        logger.error(
          { url: urlHost(url), status, event: payload.event, storyId: payload.storyId, attempt },
          'Webhook delivery failed after all retries'
        );
        await enqueueWebhookDlq(payload, url, `HTTP ${status} after ${attempt} attempts`);
        return;
      }

      // Any other status — permanent failure
      logger.error(
        { url: urlHost(url), status, event: payload.event, storyId: payload.storyId },
        'Webhook delivery failed with unexpected status'
      );
      await enqueueWebhookDlq(payload, url, `Unexpected HTTP ${status}`);
      return;
    }
  } finally {
    // H5: Release the pinned dispatcher's sockets so a long-lived worker does
    // not leak one keep-alive connection per webhook delivery.
    if (dispatcher) {
      await dispatcher.close().catch(() => {});
    }
  }
}

async function enqueueWebhookDlq(
  payload: WebhookPayload,
  webhookUrl: string,
  lastError: string
): Promise<void> {
  try {
    await getStoryDlq().add('webhook-failed', {
      jobId: payload.jobId,
      genre: payload.genre ?? [],
      addedAt: Date.now(),
      _failedReason: lastError,
      _failedAt: Date.now(),
    } as DlqEntry, { jobId: `dlq-${payload.jobId}` });
  } catch (dlqErr) {
    logger.error({ dlqErr }, 'Failed to enqueue webhook failure to DLQ');
  }
}