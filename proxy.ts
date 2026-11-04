import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const protectedRoutes = ['/', '/history', '/create', '/settings', '/admin']
const authRoute = '/login'

// JWT format check: 3 base64url segments separated by dots (optional padding)
const JWT_REGEX = /^[a-zA-Z0-9_-]+=*\.[a-zA-Z0-9_-]+=*\.[a-zA-Z0-9_-]+=*$/

interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  jti: string;
  iat?: number;
  exp?: number;
}

function base64urlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importJwtSecret(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

/**
 * Verify a JWT token using the configured JWT_SECRET.
 * Returns the decoded payload if the signature is valid and the token is not expired.
 * Returns null for malformed, forged, or expired tokens.
 *
 * This runs in the Next.js Edge Runtime, so it uses the Web Crypto API instead
 * of Node.js crypto.
 */
export async function verifyJwtToken(token: string): Promise<JwtPayload | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return null;
  }
  if (!JWT_REGEX.test(token)) {
    return null;
  }
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) {
    return null;
  }
  try {
    const key = await importJwtSecret(secret);
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const expected = base64urlDecode(signature);
    const valid = await crypto.subtle.verify('HMAC', key, expected, data);
    if (!valid) {
      return null;
    }
    const decoded = JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as JwtPayload;
    if (!decoded.sub || !decoded.role) {
      return null;
    }
    if (decoded.exp && decoded.exp * 1000 <= Date.now()) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Generate a strict Content-Security-Policy with a per-request nonce.
 * The nonce is added to the REQUEST headers (via NextResponse.next({ request }))
 * so server components can read it via `headers().get('x-csp-nonce')` and render
 * `<body nonce>` / `<Script nonce>` with the SAME value the CSP response header
 * advertises. Setting it only on the response header left `headers()` empty on
 * the server while Next applied the real nonce on the client, producing a React
 * #418 hydration mismatch on every page.
 *
 * style-src keeps 'unsafe-inline' because framer-motion injects runtime
 * inline styles for animations and does not support nonce-based CSP. Script
 * tags use the nonce instead of 'unsafe-inline', which blocks injected inline
 * scripts while still allowing Next.js hydration and legitimate `<Script>`
 * components.
 */
function generateCspNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildCspHeader(nonce: string, devApi: string, prodApi: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src 'self'${devApi}${prodApi}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');
}

function shouldSkipCsp(request: NextRequest): boolean {
  const accept = request.headers.get('accept') || '';
  const pathname = request.nextUrl.pathname;
  const isHtmlRequest = accept.includes('text/html');
  const isAsset =
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/images/') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.svg');
  return isAsset || (!isHtmlRequest && !pathname.startsWith('/api/'));
}

function applyCspHeaders(response: NextResponse, nonce: string | null): NextResponse {
  if (!nonce) {
    return response;
  }
  const devApi = process.env.NODE_ENV !== 'production' ? ' http://localhost:34567' : '';
  const prodApi = process.env.NEXT_PUBLIC_API_URL ? ` ${process.env.NEXT_PUBLIC_API_URL}` : '';
  const csp = buildCspHeader(nonce, devApi, prodApi);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// Next.js proxy for auth redirects and public-asset bypasses.
// Backend request proxying lives in app/api/[...path]/route.ts.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isProtected = protectedRoutes.some(
    (route) => pathname === route || pathname.startsWith('/story/')
  )
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/')
  const isAuthRoute = pathname === authRoute || pathname === `${authRoute}/`
  const isPublicAsset =
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/images/') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.svg')

  if (isPublicAsset) {
    // Assets skip CSP entirely (see shouldSkipCsp) and render no layout, so a
    // plain pass-through is correct here — no nonce/request-header plumbing.
    return NextResponse.next()
  }

  const token = request.cookies.get('access_token')?.value
  const payload = token ? await verifyJwtToken(token) : null
  const hasValidJwt = payload !== null
  const isAdmin = payload?.role === 'admin'

  // CSP nonce: attach to the REQUEST headers so Server Components can read it
  // via headers() and render <body>/<Script> with the same value the CSP
  // response header uses (see the note above generateCspNonce).
  let requestHeaders: Headers | undefined
  let cspNonce: string | null = null
  if (!shouldSkipCsp(request)) {
    cspNonce = generateCspNonce()
    requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-csp-nonce', cspNonce)
  }
  const nextResponse = () =>
    NextResponse.next(requestHeaders ? { request: { headers: requestHeaders } } : undefined)

  const isXmlHttpRequest = request.headers.get('x-requested-with') === 'XMLHttpRequest'
  const acceptsHtml = request.headers.get('accept')?.includes('text/html')

  let response: NextResponse

  // Role-gate /admin at the edge: only users with role === 'admin' may access
  // the admin dashboard. Non-admin authenticated users are redirected to /.
  if (isAdminRoute && !isAdmin) {
    if (isXmlHttpRequest || !acceptsHtml) {
      response = new NextResponse(null, { status: 403 })
    } else {
      response = NextResponse.redirect(new URL('/', request.url))
    }
  } else if (isProtected && !hasValidJwt) {
    if (isXmlHttpRequest || !acceptsHtml) {
      response = nextResponse()
    } else {
      const loginUrl = new URL(authRoute, request.url)
      loginUrl.searchParams.set('from', pathname)
      // L4-LOGIN-REDUX: include a `msg` parameter so the login page
      // can show a friendly explanation instead of appearing blank.
      // The user clicked something that requires auth; this tells
      // them why they're being asked to sign in again.
      loginUrl.searchParams.set('msg', 'Please sign in to access that page')
      response = NextResponse.redirect(loginUrl)
    }
  } else if (isAuthRoute && hasValidJwt) {
    response = NextResponse.redirect(new URL('/', request.url))
  } else {
    response = nextResponse()
  }

  return applyCspHeaders(response, cspNonce)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|api/|.*\\.png$|favicon.*).*)',
  ],
}
