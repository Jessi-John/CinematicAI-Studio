/**
 * Tests for the metrics-access ACL (L4-METRICS-NETWORK).
 *
 * The metrics endpoint is accessible from:
 *   - localhost (127.0.0.0/8, ::1) — for `curl http://localhost:34567/metrics`
 *     during local debugging
 *   - all private Docker ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *     so Prometheus can scrape `backend:34567/metrics` from inside the
 *     container network regardless of the assigned subnet
 *
 * Everything else gets 401. These tests pin the ACL so a future change
 * to the subnet list or the CIDR math doesn't silently open or close
 * the door.
 */
import { describe, it, expect } from 'vitest';
import { metricsRequestAllowed, _test } from './metrics-acl.js';

describe('metricsRequestAllowed (L4-METRICS-NETWORK)', () => {
  describe('loopback', () => {
    it('allows 127.0.0.1', () => {
      expect(metricsRequestAllowed('127.0.0.1')).toBe(true);
    });
    it('allows any 127.x.x.x address (entire /8 loopback range)', () => {
      expect(metricsRequestAllowed('127.0.0.1')).toBe(true);
      expect(metricsRequestAllowed('127.0.0.42')).toBe(true);
      expect(metricsRequestAllowed('127.255.255.254')).toBe(true);
    });
    it('normalizes IPv4-mapped IPv6 loopback to 127.0.0.1', () => {
      // Express socket address is sometimes ::ffff:127.0.0.1
      expect(metricsRequestAllowed('::ffff:127.0.0.1')).toBe(true);
    });
    it('allows plain IPv6 ::1', () => {
      expect(metricsRequestAllowed('::1')).toBe(true);
    });
  });

  describe('private Docker ranges', () => {
    it('allows 172.16.0.0/12 container IPs (covers former 172.20.0.0/16 subnet)', () => {
      // The compose file no longer pins a static subnet, so the ACL allows the
      // whole RFC1918 172.16.0.0/12 range Prometheus may be assigned to.
      expect(metricsRequestAllowed('172.20.0.40')).toBe(true);
      expect(metricsRequestAllowed('172.20.0.10')).toBe(true); // postgres
      expect(metricsRequestAllowed('172.20.0.20')).toBe(true); // redis
      expect(metricsRequestAllowed('172.20.0.70')).toBe(true); // prometheus
      expect(metricsRequestAllowed('172.20.255.255')).toBe(true);
      expect(metricsRequestAllowed('172.16.0.1')).toBe(true);
      expect(metricsRequestAllowed('172.31.255.255')).toBe(true);
    });
    it('rejects 172.32.0.0 (just above 172.16.0.0/12)', () => {
      expect(metricsRequestAllowed('172.32.0.1')).toBe(false);
    });
    it('rejects 172.15.0.0 (just below 172.16.0.0/12)', () => {
      expect(metricsRequestAllowed('172.15.255.255')).toBe(false);
    });
    it('allows 10.0.0.0/8 (Docker default bridge / private)', () => {
      expect(metricsRequestAllowed('10.0.0.1')).toBe(true);
      expect(metricsRequestAllowed('10.1.2.3')).toBe(true);
      expect(metricsRequestAllowed('10.255.255.255')).toBe(true);
    });
    it('allows 192.168.0.0/16 (private LAN / Docker)', () => {
      expect(metricsRequestAllowed('192.168.0.1')).toBe(true);
      expect(metricsRequestAllowed('192.168.255.255')).toBe(true);
    });
  });

  describe('external addresses are blocked', () => {
    it('rejects 8.8.8.8 (Google DNS, public)', () => {
      expect(metricsRequestAllowed('8.8.8.8')).toBe(false);
    });
    it('rejects 169.254.0.1 (link-local)', () => {
      expect(metricsRequestAllowed('169.254.0.1')).toBe(false);
    });
    it('rejects null/empty remoteAddress (defensive)', () => {
      expect(metricsRequestAllowed(null)).toBe(false);
      expect(metricsRequestAllowed('')).toBe(false);
    });
    it('rejects malformed IPs (defensive)', () => {
      expect(metricsRequestAllowed('not-an-ip')).toBe(false);
      expect(metricsRequestAllowed('999.999.999.999')).toBe(false);
    });
    it('rejects pure IPv6 non-loopback (only ::1 is allowed)', () => {
      expect(metricsRequestAllowed('2001:db8::1')).toBe(false);
      expect(metricsRequestAllowed('fe80::1')).toBe(false);
    });
  });

  describe('CIDR math (sanity)', () => {
    it('boundary 172.16.0.0/12', () => {
      expect(_test.ipInCidr('172.16.0.0', '172.16.0.0/12')).toBe(true);
      expect(_test.ipInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
      expect(_test.ipInCidr('172.15.255.255', '172.16.0.0/12')).toBe(false);
      expect(_test.ipInCidr('172.32.0.0', '172.16.0.0/12')).toBe(false);
    });
    it('boundary 127.0.0.0/8 — 127.255.255.255 is IN, 128.0.0.0 is OUT', () => {
      expect(_test.ipInCidr('127.255.255.255', '127.0.0.0/8')).toBe(true);
      expect(_test.ipInCidr('128.0.0.0', '127.0.0.0/8')).toBe(false);
    });
    it('returns false for malformed CIDR', () => {
      expect(_test.ipInCidr('1.2.3.4', 'not-a-cidr')).toBe(false);
      expect(_test.ipInCidr('1.2.3.4', '1.2.3.4/40')).toBe(false);
      expect(_test.ipInCidr('1.2.3.4', '1.2.3.256/24')).toBe(false);
    });
  });
});
