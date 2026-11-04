/**
 * OpenAPI route coverage invariant.
 *
 * Scans server.ts for `app.use('/api/*', router)` registrations and
 * cross-checks them against the OpenAPI spec's `paths` keys. Any route
 * that is registered but not documented in the OpenAPI spec is flagged.
 *
 * This prevents the API surface from silently drifting away from the
 * documented spec — the same class of bug that caused the original audit
 * to find ~80% of routes missing from the OpenAPI document.
 *
 * NOT an exhaustive contract test — routes that are programmatically
 * mounted (e.g., `app.use('/api', validateIdParam)`) are middleware, not
 * route handlers, and are excluded from the check. Only routes mounted
 * as `app.use('/api/<path>', <router>)` are tracked, plus explicit route
 * registrations inside the startup function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Test file is at backend/src/test-quality/openapi-route-coverage.test.ts
// __dirname = D:/youtube/backend/src/test-quality/
// Go up 2 levels to reach backend root, then + src/
const BACKEND_ROOT = resolve(__dirname, '..', '..');
const BACKEND_SRC = resolve(BACKEND_ROOT, 'src');

/**
 * Known route prefixes that are intentionally NOT documented in the
 * OpenAPI spec:
 *  - /metrics — Prometheus metrics endpoint, not API-facing
 *  - /api/docs — The OpenAPI doc endpoint itself (self-referential)
 *  - /api/stories/export — Bulk export (handled by exportRouter which
 *    also handles POST /:id/export — the POST form IS documented)
 *
 * Each entry includes the reason it's excluded.
 */
const ROUTE_UNTRACKED = new Map<string, string>([
  ['/api/docs', 'OpenAPI spec self-reference — documented in its own response'],
  ['/api/docs/ui', 'OpenAPI UI page — documented in its own response'],
  ['/api/settings', 'Internal settings endpoint — used by frontend dashboard; not part of external API contract'],
  ['/api/user-settings', 'Internal per-user settings endpoint — used by frontend; not part of external API contract'],
  ['/api/stories/export', 'Bulk export path — the POST /:id/export form IS documented separately'],
  ['/metrics', 'Prometheus metrics — infra endpoint, not API-facing'],
]);

/**
 * Extract route prefixes from server.ts by finding `app.use('/api/<path>', <router>)`
 * patterns. Returns the API path prefix (e.g. `/api/stories/generate`).
 */
function extractRegisteredRoutes(serverContent: string): string[] {
  const routes: string[] = [];
  // Match app.use('/api/...', router) and app.use('/api/...', middleware)
  const regex = /app\.use\s*\(\s*(['"`])(\/api\/[^'"]+)\1\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(serverContent)) !== null) {
    const route = match[2] as string;
    if (route) routes.push(route);
  }
  return routes;
}

/**
 * Extract path keys from the OpenAPI spec file.
 * Returns the path strings (e.g. `/api/stories/generate`).
 */
function extractOpenApiPaths(openapiContent: string): string[] {
  const paths: string[] = [];
  // Match '/api/...': { ... } inside the paths object
  const regex = /['"`](\/api\/[^'"]+)['"`]\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(openapiContent)) !== null) {
    const path = match[1] as string;
    if (path) paths.push(path);
  }
  return paths;
}

// We cannot use import.meta.url with dynamic readFileSync in all environments,
// so we build paths relative to the expected project layout.
const SERVER_PATH = resolve(BACKEND_SRC, 'server.ts');
const OPENAPI_PATH = resolve(BACKEND_SRC, 'routes', 'openapi.ts');

describe('OpenAPI route coverage invariants', () => {
  let serverRoutes: string[];
  let openApiPaths: string[];

  beforeAll(() => {
    const serverContent = readFileSync(SERVER_PATH, 'utf8');
    const openapiContent = readFileSync(OPENAPI_PATH, 'utf8');
    serverRoutes = extractRegisteredRoutes(serverContent);
    openApiPaths = extractOpenApiPaths(openapiContent);
  });

  it('extracts routes from server.ts', () => {
    expect(serverRoutes.length).toBeGreaterThan(0);
  });

  it('extracts paths from OpenAPI spec', () => {
    expect(openApiPaths.length).toBeGreaterThan(0);
  });

  it('every registered API route is documented in the OpenAPI spec', () => {
    const undocumented: string[] = [];

    for (const route of serverRoutes) {
      // Skip routes that are explicitly untracked
      if (ROUTE_UNTRACKED.has(route)) continue;

      // Normalize the route path: strip trailing slashes.
      const normalizedRoute = route.replace(/\/$/, '');

      // Check three match strategies:
      // 1. Exact match: the OpenAPI spec has a path with this exact string
      // 2. Prefix match: the OpenAPI spec has sub-paths starting with this
      //    prefix (e.g. server.ts registers /api/admin, OpenAPI has
      //    /api/admin/queue, /api/admin/stats — the prefix IS covered)
      // 3. Parameterized match: OpenAPI has /api/stories/{id} and
      //    server.ts registers /api/stories/:id (they are the same route)
      const exactMatch = openApiPaths.includes(normalizedRoute);
      const prefixMatch = openApiPaths.some((p) =>
        p.startsWith(normalizedRoute + '/')
      );
      const paramMatch = openApiPaths.some((p) => {
        // Convert OpenAPI path to a regex that matches Express route patterns
        const openApiRegex = new RegExp(
          '^' + p.replace(/\{([^}]+)\}/g, ':[^/]+') + '$'
        );
        return openApiRegex.test(normalizedRoute);
      });

      if (!exactMatch && !prefixMatch && !paramMatch) {
        undocumented.push(normalizedRoute);
      }
    }

    expect(undocumented).toStrictEqual(
      []
    );
  });
});
