import type { NextConfig } from 'next';
import withBundleAnalyzer from '@next/bundle-analyzer';

/**
 * Next.js configuration.
 *
 * Fix #49: add the production hardening that the original file was
 * missing — security headers, image domain allowlist, and a more
 * granular output mode. The defaults from `next start` are reasonable
 * for development but ship CSP/Referrer-Policy defaults that are
 * weaker than what `helmet` sets on the Express backend. We mirror
 * the backend's posture here so a compromised image or third-party
 * script cannot exfiltrate data.
 *
 * L4 — @next/bundle-analyzer integration. Enable by setting ANALYZE=true:
 *   ANALYZE=true npm run build
 * Generates client.html and server.html in .next/analyze/.
 */
const withBundle = withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = withBundle({
  output: 'standalone',

  // Defense-in-depth security headers. The Express backend already sets
  // these via helmet, but the Next.js server also serves its own routes
  // (login, register, static assets) and the dashboard. Setting them at
  // the framework level guarantees they apply to every response,
  // including error pages and 404s.
  async headers() {
    // CRIT-5: CSP is NOT set here — it is generated per-request by proxy.ts
    // with a per-request nonce for script-src, which is strictly more secure
    // than a static 'unsafe-inline' directive. proxy.ts covers all page routes
    // (its matcher excludes /api/). API routes serve JSON, not HTML, so CSP
    // is not needed there. The remaining headers apply to all routes as
    // defense-in-depth.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },

  // Image optimization. MED-9: Removed wildcard https remotePatterns — the app
  // does not use next/image with remote URLs. If remote image sources are added
  // in the future, add explicit hostnames here (not '**'). The default allowlist
  // is empty, which means local and data: URIs only.
  images: {
    remotePatterns: [],
  },

  // Production-only build optimization. Standalone mode is already
  // enabled above; this is a marker for future tuning.
  poweredByHeader: false,

  // L4-FRONTEND-DASHBOARD: the authenticated app lives under the
  // (dashboard) route group, which is invisible in the URL — the
  // dashboard renders at "/" and sub-pages are at /create,
  // /history, /settings. The route group is invisible in the URL,
  // so a user typing "/dashboard" gets a 404. We add a permanent
  // redirect so old bookmarks, support emails, and share-links that
  // reference "/dashboard" still land on the right page. The 308
  // status preserves the method (so any future POST/PUT/DELETE
  // /dashboard would forward correctly).
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: true },
    ];
  },
});

export default nextConfig;
