/**
 * L4-METRICS-NETWORK: ACL for the /metrics endpoint.
 *
 * The metrics endpoint exposes AI-call counts, queue depths, request
 * durations, and similar operational signals. It must NOT be public —
 * those numbers reveal how many tokens we burn and what models we
 * use, which is competitive intel. But it must be reachable from
 * Prometheus, which runs in a sibling container on the Docker
 * compose network. This module centralises the allow-list so it can
 * be unit-tested without spinning up a server.
 *
 * Allowed sources:
 *   - localhost (127.0.0.0/8, ::1) for `curl http://localhost:34567/metrics`
 *     during local debugging
 *   - all private Docker ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *     so Prometheus scraping `backend:34567/metrics` gets through regardless
 *     of the compose subnet Docker assigns
 *
 * Everything else gets 401.
 */
// M47: env-configurable CIDR list — the hardcoded list allowed the whole
// RFC1918 LAN. Set METRICS_ALLOWED_CIDRS to a comma-separated list to
// narrow it (e.g. the compose subnet only).
const DEFAULT_METRICS_ALLOWED_SUBNETS: ReadonlyArray<{ family: 'ipv4' | 'ipv6'; cidr: string }> = [
  { family: 'ipv4', cidr: '127.0.0.0/8' },   // loopback
  { family: 'ipv4', cidr: '10.0.0.0/8' },     // Docker default bridge / private range
  { family: 'ipv4', cidr: '172.16.0.0/12' },  // Docker container networks
  { family: 'ipv4', cidr: '192.168.0.0/16' }, // Private LAN / Docker
];

function getAllowedSubnets(): ReadonlyArray<{ family: 'ipv4' | 'ipv6'; cidr: string }> {
  const raw = process.env.METRICS_ALLOWED_CIDRS;
  if (!raw) return DEFAULT_METRICS_ALLOWED_SUBNETS;
  return raw.split(',').map((c) => {
    const cidr = c.trim();
    return { family: (cidr.includes(':') ? 'ipv6' : 'ipv4') as 'ipv4' | 'ipv6', cidr };
  });
}

/**
 * Test whether a raw socket remoteAddress (the value Express gives us
 * via `req.socket.remoteAddress`) is in the metrics allow-list.
 *
 * The function is intentionally lenient about input shape (it
 * normalises IPv4-mapped IPv6, accepts null/empty as a hard reject)
 * so the caller can pass `req.socket.remoteAddress` directly without
 * any pre-validation.
 */
export function metricsRequestAllowed(remoteAddr: string | null | undefined): boolean {
  if (!remoteAddr) return false;
  let ip = remoteAddr;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) {
    // Pure IPv6 — only loopback is allowed in this minimal ACL.
    return ip === '::1';
  }
  return getAllowedSubnets().some((s) => s.family === 'ipv4' && ipInCidr(ip, s.cidr));
}

/**
 * Pure CIDR-match helper. Returns true when `ip` is inside `cidr`.
 * Handles invalid input by returning false (defensive — the caller
 * should treat false as "deny").
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  if (!base || !bitsStr) return false;
  const bits = parseInt(bitsStr, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const parts = base.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const baseNum = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const ipParts = ip.split('.').map((p) => parseInt(p, 10));
  if (ipParts.length !== 4 || ipParts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const ipNum = ((ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!) >>> 0;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (baseNum & mask) === (ipNum & mask);
}

/**
 * Internal helpers exposed for unit tests only. Consumers should call
 * metricsRequestAllowed / ipInCidr directly.
 */
export const _test = { ipInCidr };
