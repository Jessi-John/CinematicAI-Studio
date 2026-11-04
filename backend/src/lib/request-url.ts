import type express from 'express';

/**
 * Build the public URL for the current request.
 *
 * The backend sits behind the Next.js BFF (and possibly a TLS-terminating
 * reverse proxy). The BFF forwards the original protocol and host in
 * `x-forwarded-proto` and `x-forwarded-host`. When those headers are present,
 * they must take precedence over the local connection details, otherwise
 * absolute URLs returned to clients would contain the internal `backend:34567`
 * host and break SSE streams, webhooks, and refresh-auth links.
 *
 * HIGH #26: Previously the backend used `req.protocol` + `req.get('host')`
 * directly, but the BFF intentionally deletes the `Host` header and replaces it
 * with `x-forwarded-host`. Without this helper, `sseUrl` was generated with the
 * wrong hostname.
 *
 * Trust model (host-injection hardening): `x-forwarded-host` is only safe to
 * use because the upstream proxy OVERWRITES it with the validated public host.
 * In production Caddy sets `header_up X-Forwarded-Host {host}` and only serves
 * requests whose Host matches {$CADDY_HOST} (see deploy/caddy/Caddyfile); the
 * Next.js BFF sets it from the canonical request URL. A deployment that exposes
 * the backend port directly (no proxy) MUST NOT rely on this header, since a
 * client could then spoof the host embedded in absolute URLs (e.g. sseUrl).
 */
export function getPublicBaseUrl(req: express.Request): string {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) {
    // This should never happen in a real HTTP request, but fail loudly rather
    // than generate an invalid URL.
    throw new Error('Cannot determine request host');
  }
  return `${protocol}://${host}`;
}
