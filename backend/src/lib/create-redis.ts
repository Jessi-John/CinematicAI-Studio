/**
 * Shared Redis connection factory with Docker DNS cache bypass.
 *
 * All Redis connections in the application should use this factory to ensure
 * consistent DNS resolution behavior. The custom dnsLookup forces a fresh
 * DNS resolution on every connection attempt, bypassing Docker's embedded
 * DNS cache (127.0.0.11). This eliminates the need for static IPs in
 * docker-compose.yml — containers can use dynamic IPs and `docker compose
 * up --scale` works natively (REL-030).
 */

import { Redis, type RedisOptions } from 'ioredis';
import dns from 'node:dns';

/**
 * Custom dnsLookup function that forces fresh DNS resolution on every call.
 * Bypasses Docker's embedded DNS cache which otherwise returns stale IPs
 * when containers recreate at different addresses during scaling events.
 */
export function freshDnsLookup(hostname: string, cb: (err: Error | null, address: string, family: number) => void): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, result) => {
    if (err) { cb(err, '', 4); return; }
    const addrs = result as Array<{ address: string; family: number }> | undefined;
    if (!addrs || addrs.length === 0) { cb(new Error('No DNS results for ' + hostname), '', 4); return; }
    const first = addrs[0];
    if (!first) { cb(new Error('No DNS results for ' + hostname), '', 4); return; }
    cb(null, first.address, first.family);
  });
}

/**
 * Base Redis options that all connections should share.
 * Includes the DNS lookup fix and standard retry/error handling.
 * Uses a type assertion for dnsLookup which is not in ioredis 5.x type defs
 * but IS supported at runtime (added in ioredis 5.3+).
 */
export function getBaseRedisOptions(overrides?: Partial<RedisOptions>): RedisOptions {
  return {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
    lazyConnect: true,
    connectTimeout: 10_000,
    dnsLookup: freshDnsLookup as unknown as undefined,
    ...overrides,
  } as RedisOptions;
}

/**
 * Create a new Redis client with the DNS lookup fix applied.
 * Prefer this over `new Redis(url, opts)` directly.
 */
export function createRedis(url: string, options?: Partial<RedisOptions>): Redis {
  return new Redis(url, getBaseRedisOptions(options));
}
