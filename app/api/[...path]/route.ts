import { NextRequest, NextResponse } from 'next/server';

// Lazy getter for the Express API base URL. Used inside the proxy function
// rather than captured at module scope to avoid import-order issues.
// Fix HIGH-21: fail fast when API_BASE_URL is missing instead of silently
// falling back to localhost, which can cause production containers to call
// themselves and expose confusing errors.
function getApiBaseUrl(): string {
  const url = process.env.API_BASE_URL;
  if (!url) {
    throw new Error('API_BASE_URL is not configured');
  }
  return url;
}

/**
 * Generate a lightweight request ID for BFF proxy requests.
 * Uses a timestamp prefix + random suffix for correlating proxy errors
 * with backend logs without requiring a UUID dependency.
 */
function generateRequestId(): string {
  return `bff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Determine the real client IP for the backend.
 *
 * Next.js App Router does not expose the socket IP on NextRequest, so the old
 * `(req as { ip?: string }).ip` was always undefined and this returned
 * 'unknown' for every request. That collapsed all clients into a single
 * rate-limit bucket on the backend (which keys on req.ip via `trust proxy`).
 *
 * In the Docker topology Caddy is the sole ingress and OVERWRITES
 * X-Real-IP / X-Forwarded-For to the real peer (deploy/caddy/Caddyfile), so
 * those headers are trustworthy here — an attacker cannot reach the BFF
 * directly to spoof them. We therefore trust X-Real-IP (a single value, no
 * chain parsing). We deliberately still do NOT trust the client-supplied
 * X-Forwarded-For chain (a multi-hop header that is trivially spoofable when
 * the BFF is reached without the proxy), preserving the original distrust.
 */
function getClientIp(req: NextRequest): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  const directIp = (req as { ip?: string }).ip;
  if (directIp) return directIp;
  return 'unknown';
}

/**
 * Structured error logger for the BFF proxy.
 * Outputs a JSON line to stdout so it can be ingested by log aggregators
 * alongside the backend's pino logs. Each entry includes requestId for
 * correlation with client-side and backend-side logs.
 */
function logProxyError(requestId: string, method: string, pathname: string, error: unknown): void {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  // Write a structured JSON line that log aggregators can parse uniformly.
  // Prefix with [proxy] for easy grep-based filtering.
  const entry = JSON.stringify({
    level: 'error',
    msg: 'BFF proxy error',
    requestId,
    method,
    pathname,
    err: { message: errorMsg, ...(errorStack ? { stack: errorStack } : {}) },
    timestamp: new Date().toISOString(),
  });
  process.stderr.write(`[proxy] ${entry}\n`);
}

// Defense-in-depth: the BFF only proxies paths that the frontend legitimately
// uses. Internal/metrics/docs routes must be reached directly (or through
// the reverse proxy) and are not exposed through the same-origin BFF.
// M3: /api/admin/* IS proxied — the dashboard admin page (app/(dashboard)/admin)
// calls it via apiFetch, and the backend enforces admin auth (verifyAdminAuth)
// on every admin route, so exposing the path adds no privilege. Omitting it
// made every admin call 404 through the BFF.
const ALLOWED_PATHS: Array<{ pattern: RegExp; methods: string[] }> = [
  { pattern: /^\/api\/auth(?:\/.*)?$/, methods: ['GET', 'POST', 'DELETE'] },
  { pattern: /^\/api\/stories\/generate\/[^/]+\/(events|status|refresh-auth)$/, methods: ['GET'] },
  { pattern: /^\/api\/stories(?:\/.*)?$/, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/admin(?:\/.*)?$/, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/settings(?:\/.*)?$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/api\/user-settings(?:\/.*)?$/, methods: ['GET', 'PUT', 'DELETE'] },
  { pattern: /^\/api\/health(?:\/.*)?$/, methods: ['GET'] },
  { pattern: /^\/api\/public-config(?:\/.*)?$/, methods: ['GET'] },
];

function isAllowedPath(method: string, pathname: string): boolean {
  let bestMatch: { specificity: number; methods: string[] } | null = null;
  for (const rule of ALLOWED_PATHS) {
    if (rule.pattern.test(pathname)) {
      const specificity = rule.pattern.source.length;
      if (!bestMatch || specificity > bestMatch.specificity) {
        bestMatch = { specificity, methods: rule.methods };
      }
    }
  }
  return bestMatch !== null && bestMatch.methods.includes(method);
}

// JWT shape used by the backend: three base64url segments separated by dots.
const JWT_REGEX = /^[a-zA-Z0-9_-]+=*\.[a-zA-Z0-9_-]+=*\.[a-zA-Z0-9_-]+=*$/;

function isValidAuthorization(value: string): boolean {
  if (value.startsWith('Bearer ')) {
    const token = value.slice(7);
    return JWT_REGEX.test(token);
  }
  return false;
}

export async function GET(req: NextRequest) {
    return proxyRequest(req);
}

export async function POST(req: NextRequest) {
    return proxyRequest(req);
}

export async function PUT(req: NextRequest) {
    return proxyRequest(req);
}

export async function PATCH(req: NextRequest) {
    return proxyRequest(req);
}

export async function DELETE(req: NextRequest) {
    return proxyRequest(req);
}

async function proxyRequest(req: NextRequest): Promise<NextResponse> {
    const requestId = req.headers.get('x-request-id') || generateRequestId();
    const pathname = req.nextUrl.pathname;
    const search = req.nextUrl.search;
    const method = req.method;

    // Defense-in-depth: reject paths/methods the frontend does not need.
    if (!isAllowedPath(method, pathname)) {
      return NextResponse.json(
        { success: false, error: 'Not allowed', requestId },
        { status: 404 }
      );
    }

    // M3: targetUrl is computed INSIDE the try below. Previously it was computed
    // here (outside the try), so a missing API_BASE_URL made getApiBaseUrl()
    // throw uncaught — the route returned a 500 instead of the intended 503,
    // and the isConfigError branch in the catch was dead code.

    // Fix: Sanitize forwarded headers. Previously ALL client-originated headers
    // (Cookie, Authorization, X-CSRF-Token) were forwarded verbatim. We now
    // construct a fresh Headers object with only the headers the backend needs,
    // preventing misconfigured reverse proxies from forwarding attacker-controlled
    // values. This is defense-in-depth — the backend still validates auth, but
    // the BFF no longer blindly passes through every header.
    // L23: X-Forwarded-For/Proto/Host are NOT forwarded from the client — they
    // are attacker-controllable and the comment above claiming the allowlist
    // "prevents forwarding attacker-controlled values" was false while these
    // were included. The BFF sets its own X-Forwarded-* from trusted values.
    const requestHeaders = new Headers();
    const ALLOWED_FORWARD_HEADERS = new Set([
      'content-type', 'accept', 'accept-language',
      'x-csrf-token', 'x-request-id', 'cookie',
      // M39: 'content-length' deliberately EXCLUDED — the BFF re-serializes
      // JSON bodies (JSON.stringify(JSON.parse(raw))), which can change the
      // byte length; a stale client content-length then makes undici throw
      // "Request body length does not match content-length header" → 502 for
      // any non-compact JSON client. undici recomputes it when absent.
    ]);
    for (const [key, value] of req.headers.entries()) {
      if (ALLOWED_FORWARD_HEADERS.has(key)) {
        requestHeaders.set(key, value);
      }
    }
    // Authorization is forwarded only when it looks like a Bearer JWT.
    // This prevents the BFF from relaying arbitrary attacker-controlled headers
    // while still supporting API clients that authenticate via Bearer token.
    const authHeader = req.headers.get('authorization');
    if (authHeader && isValidAuthorization(authHeader)) {
      requestHeaders.set('authorization', authHeader);
    }
    // Set trusted X-Forwarded-* headers from the BFF, not from the client.
    // CRITICAL-3: Preserve the original client protocol when the request comes
    // through a TLS-terminating reverse proxy (e.g. Caddy). Inside Docker the
    // BFF sees req.nextUrl.protocol as 'http', which would break the backend's
    // HTTPS-only JWT cookie enforcement. Trust the upstream x-forwarded-proto
    // when it is 'https'; otherwise fall back to the local request protocol.
    const trustedProto = req.nextUrl.protocol.replace(':', '');
    requestHeaders.set('x-forwarded-proto', trustedProto);
    // BFF-014/BFF-026: set trusted forwarding headers from the BFF itself.
    // The backend needs the original client IP for rate limiting and the
    // original host to build absolute URLs (e.g. sseUrl). We must not forward
    // attacker-controlled values, so we drop the incoming Host header and
    // replace it with the canonical request URL host.
    requestHeaders.set('x-forwarded-for', getClientIp(req));
    requestHeaders.set('x-forwarded-host', req.nextUrl.host);
    requestHeaders.delete('host');

    let body: BodyInit | null = null;
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json') && !['GET', 'HEAD'].includes(req.method)) {
        // M3: Read the raw text first so a BODYLESS JSON POST (e.g.
        // POST /api/auth/refresh — apiFetch always sends Content-Type:
        // application/json even with no body) forwards cleanly instead of
        // failing req.json() with a 400 "Invalid JSON body". Only validate and
        // round-trip the JSON when a body is actually present.
        const raw = await req.text();
        if (raw.length > 0) {
            try {
                body = JSON.stringify(JSON.parse(raw));
            } catch {
                return NextResponse.json(
                    { success: false, error: 'Invalid JSON body' },
                    { status: 400 }
                );
            }
        }
    } else {
        body = await req.text();
    }

    try {
        // M3: resolve the target inside the try so a missing API_BASE_URL is
        // caught below and surfaced as 503 (not an uncaught 500).
        const targetUrl = `${getApiBaseUrl()}${pathname}${search}`;
        const isSSE = req.headers.get('accept')?.includes('text/event-stream');

        const bodyInit: BodyInit | null = body;

        // Fix: Add a timeout to the proxy fetch request. Previously, the fetch
        // would hang indefinitely for SSE connections that never close, consuming
        // a Node.js socket and a Lambda/container connection until the client
        // disconnects. Under load, this causes socket exhaustion. The default
        // 5-minute timeout matches the backend's REQUEST_TIMEOUT_MS default.
        // For SSE streams, we extend the timeout to the backend's SSE hard
        // ceiling (2 hours) so long-running generations are not truncated.
        const SSE_TIMEOUT_MS = 7_200_000;
        const defaultTimeoutMs = isSSE ? SSE_TIMEOUT_MS : 300_000;
        const proxyTimeoutMs = (() => {
          const raw = process.env.PROXY_TIMEOUT_MS ?? String(defaultTimeoutMs);
          const parsed = parseInt(raw, 10);
          return Number.isNaN(parsed) || parsed <= 0 ? defaultTimeoutMs : parsed;
        })();
        const proxyAbort = new AbortController();
        const proxyTimeout = setTimeout(() => proxyAbort.abort(), proxyTimeoutMs);

        try {
          const response = await fetch(targetUrl, {
              method: req.method,
              headers: requestHeaders,
              body: ['GET', 'HEAD'].includes(req.method) ? null : bodyInit,
              signal: proxyAbort.signal,
          });

          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete('content-encoding');

          // Fix: Forward every Set-Cookie header explicitly. Next.js App Router
          // can collapse or drop multi-value cookies when copied via Headers.
          const setCookies = response.headers.getSetCookie();
          responseHeaders.delete('set-cookie');
          for (const cookie of setCookies) {
            responseHeaders.append('set-cookie', cookie);
          }

          if (isSSE || response.headers.get('content-type')?.includes('text/event-stream')) {
              // For SSE, pipe through a ReadableStream with auto-close on end.
              // When the backend sends the final SSE event and closes, the stream
              // ends and we resolve. If the backend never closes, the proxy timeout
              // fires and aborts the connection, preventing socket leaks.
              const sseStream = response.body;
              if (!sseStream) {
                return new NextResponse(null, { status: 502, statusText: 'Bad Gateway' });
              }
              const reader = sseStream.getReader();
              const readable = new ReadableStream({
                async pull(controller) {
                  try {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      clearTimeout(proxyTimeout);
                      return;
                    }
                    controller.enqueue(value);
                  } catch {
                    controller.close();
                    clearTimeout(proxyTimeout);
                  }
                },
                cancel() {
                  reader.cancel().catch(() => {});
                  clearTimeout(proxyTimeout);
                },
              });
              return new NextResponse(readable, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: responseHeaders,
              });
          }

          clearTimeout(proxyTimeout);
          if (response.body) {
            return new NextResponse(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
            });
          }
          return new NextResponse(null, {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
          });
        } catch (err) {
          clearTimeout(proxyTimeout);
          // If the abort was due to our timeout, return a gateway timeout
          if (err instanceof Error && err.name === 'AbortError') {
            return NextResponse.json(
              { success: false, error: 'Proxy request timed out' },
              { status: 504 }
            );
          }
          throw err;
        }
    } catch (error) {
        logProxyError(requestId, req.method, pathname, error);
        const isConfigError = error instanceof Error && error.message === 'API_BASE_URL is not configured';
        return NextResponse.json(
            { success: false, error: isConfigError ? 'Proxy not configured' : 'Backend service unreachable', requestId },
            { status: isConfigError ? 503 : 502 }
        );
    }
}
