/**
 * Cure.md fix permanence invariants.
 *
 * Verifies that the root-cause fixes from cure.md cannot be silently
 * reverted. Each test reads the actual source files and asserts that
 * the fixed pattern remains in place.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function readLines(path: string): string[] {
  return read(path).split('\n');
}

// =============================================================================
// C2: Routes must NOT hardcode episode/scene limits
// =============================================================================

describe('C2: Route episode/scene limits use dynamic config', () => {
  const ROUTE_FILES = ['backend/src/routes/generation.ts', 'backend/src/routes/stories.ts'];

  it.each(ROUTE_FILES)('uses getEpisodesPerStory/getScenesPerEpisode in %s', (file) => {
    const content = read(file);
    expect(content).toMatch(/getEpisodesPerStory/);
    expect(content).toMatch(/getScenesPerEpisode/);
  });

  it.each(ROUTE_FILES)('has NO hardcoded 10 or 5 in episode/scene validation in %s', (file) => {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip imports, comments, and the timing.ts constants file itself
      if (line.includes('import') || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // Skip the similarity/confidence query schemas which use z.coerce.number().int().min(1).max(10)
      if (line.includes('similarityQuerySchema') || line.includes('confidenceQuerySchema')) continue;
      // Check for > 10 or > 5 in validation context (episodeNumber > X or sceneNumber > X or > maxEpisode/maxScene)
      const validationEpisode = line.match(/(episodeNumber|episode)\s*[><]\s*(10|5)\b/);
      const validationScene = line.match(/(sceneNumber|scene)\s*[><]\s*(5|10)\b/);
      if (validationEpisode || validationScene) {
        expect([line]).toEqual([]); // Fail with the offending line
      }
    }
  });
});

// =============================================================================
// H4: CSRF token must be issued on auth responses without double-setting it.
// Previously issueCsrfCookie was mounted on /api/auth AND auth route handlers
// also set the cookie, producing two XSRF-TOKEN values in one response. That
// broke double-submit validation because clients read the first value while
// cookie jars kept the last. The fix: auth route handlers set the cookie
// explicitly; issueCsrfCookie is no longer mounted on /api/auth.
// =============================================================================

describe('H4: CSRF token is issued by auth handlers, not duplicated by middleware', () => {
  it('does not mount issueCsrfCookie on /api/auth in server.ts', () => {
    const content = read('backend/src/server.ts');
    expect(content).not.toMatch(/prefix}\/auth`, issueCsrfCookie\)/);
  });

  it('auth route handlers explicitly set XSRF-TOKEN on register, login, and refresh', () => {
    const content = read('backend/src/routes/auth.ts');
    const setCsrfMatches = content.match(/setCsrfCookie\(res, generateCsrfToken\(\)\)/g);
    expect(setCsrfMatches?.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// C3: proxy.ts must protect /admin
// =============================================================================

describe('C3: proxy.ts protects /admin route', () => {
  it('includes /admin in protectedRoutes', () => {
    const content = read('proxy.ts');
    expect(content).toMatch(/\/admin/);
    const match = content.match(/protectedRoutes\s*=\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    expect(match![1]!).toContain('/admin');
  });
});

// =============================================================================
// H1: No dynamic import() in route handler files
// =============================================================================

describe('H1: Route files use static imports', () => {
  const ROUTE_FILES = [
    'backend/src/routes/generation.ts',
    'backend/src/routes/stories.ts',
    'backend/src/routes/settings.ts',
    'backend/src/routes/user-settings.ts',
    'backend/src/routes/admin.ts',
    'backend/src/routes/auth.ts',
  ];

  it.each(ROUTE_FILES)('has no dynamic await import() in %s', (file) => {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (line.includes('await import(')) {
        // Allow dynamic import() only in non-route utility functions that need it
        // (e.g., tracing.ts which must be the first import)
        expect([`${file}:${i + 1}: ${line.trim()}`]).toEqual([]);
      }
    }
  });
});

// =============================================================================
// H5: Every story mutation route must call writeAuditLog (Issue #3)
// Prevents a future developer from adding a PATCH/DELETE handler without
// recording the operation in the audit_log table.
// =============================================================================

describe('H5: Mutation routes write to audit log', () => {
  it('stories.ts has at least as many writeAuditLog calls as mutation route handlers', () => {
    const src = read('backend/src/routes/stories.ts');
    const mutationCount = (src.match(/router\.(patch|delete)\(/g) || []).length;
    const auditCount = (src.match(/writeAuditLog\(/g) || []).length;
    expect(auditCount).toBeGreaterThanOrEqual(mutationCount);
  });

  it('every PATCH/DELETE handler in stories.ts calls writeAuditLog in its try block', () => {
    const src = read('backend/src/routes/stories.ts');
    // Split by each route handler boundary
    const handlers = src.split(/router\.(patch|delete)\(/);
    // Check that each handler segment (except the first split part) contains writeAuditLog
    for (let i = 1; i < handlers.length; i++) {
      // handlers[i] starts with the matched method name
      if (i % 2 === 0) continue; // Even indices are non-handler content
      expect(handlers[i] + (handlers[i + 1] || '')).toMatch(/writeAuditLog\(/);
    }
  });
});

// =============================================================================
// H6: Auth-requiring API routes must use the API_PREFIXES loop (Issue #7)
// Prevents a future developer from hardcoding a new /api route outside the
// versioning loop, which would bypass the /api/v1 prefix.
// =============================================================================

describe('H6: API routes use version prefix loop', () => {
  const ROUTES_REQUIRING_AUTH = ['stories', 'settings', 'user-settings', 'admin'];

  it.each(ROUTES_REQUIRING_AUTH)('%s is mounted via API_PREFIXES loop, not hardcoded /api', (route) => {
    const src = read('backend/src/server.ts');
    expect(src).toMatch(new RegExp('prefix}/' + route));
  });

  it('has no hardcoded app.use(\'/api/<auth-route>\'...) before the API_PREFIXES loop', () => {
    const src = read('backend/src/server.ts');
    // Only match routes that mount DIRECTLY under /api/route (not /api/route/...)
    // The URI length guard on /api/stories/generate is permitted because it's
    // middleware, not a route handler — it must run before auth for all versions.
    for (const route of ROUTES_REQUIRING_AUTH) {
      // Match `app.use('/api/settings'` or `app.use('/api/admin'` but NOT
      // `app.use('/api/stories/generate'` (the URI check is middleware, not a route)
      const pattern = new RegExp("app\\.use\\('/api/" + route + "'[^/\\w]");
      const matches = src.match(pattern);
      if (matches) {
        expect(matches).toEqual([]); // Fail with context
      }
    }
  });
});

// =============================================================================
// M2: queue/index.ts must NOT have module-level process.env.REDIS_URL
// =============================================================================

describe('M2: queue/index.ts uses lazy getters for Redis config', () => {
  it('exports getRedisUrl function instead of module-level REDIS_URL constant', () => {
    const content = read('backend/src/queue/index.ts');
    // Must have the lazy getter
    expect(content).toMatch(/export function getRedisUrl/);
    // Must NOT have module-level REDIS_URL constant
    const lines = readLines('backend/src/queue/index.ts');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes('export const REDIS_URL') || (line.includes('const REDIS_URL') && line.includes('process.env'))) {
        expect([`${'backend/src/queue/index.ts'}:${i + 1}: ${line.trim()}`]).toEqual([]);
      }
    }
  });
});

// =============================================================================
// H3: No module-level canned fallback flag
// =============================================================================

describe('H3: No module-level canned fallback flag', () => {
  it('ai-client.ts has no __moduleLevelCannedFallback flag', () => {
    const content = read('backend/src/lib/ai-client.ts');
    expect(content).not.toMatch(/__moduleLevelCannedFallback/);
  });
});

// =============================================================================
// H5: __recordMistralEmbeddingFailure must apply exponential backoff
// =============================================================================

describe('H5: Embedding failure applies exponential backoff', () => {
  it('__recordMistralEmbeddingFailure calls __applyExponentialBackoff', () => {
    const content = read('backend/src/lib/ai-client.ts');
    // The function must contain the backoff call. Checking the function body
    // ensures that removing the backoff while keeping the function would fail.
    const funcMatch = content.match(/export function __recordMistralEmbeddingFailure\(\)[\s\S]*?^export function /m);
    const funcBody = funcMatch ? funcMatch[0]! : content;
    expect(funcBody).toMatch(/__applyExponentialBackoff/);
  });
});

// =============================================================================
// M1: issueCsrfCookie must check specifically for XSRF-TOKEN=
// =============================================================================

describe('M1: issueCsrfCookie checks for XSRF-TOKEN specifically', () => {
  it('checks for XSRF-TOKEN= prefix instead of any Set-Cookie header', () => {
    const content = read('backend/src/middleware/csrf.ts');
    const funcMatch = content.match(/export function issueCsrfCookie[\s\S]*?^export function /m);
    const funcBody = funcMatch ? funcMatch[0]! : content;
    // Must check for 'XSRF-TOKEN=' specifically, not just !res.getHeader('Set-Cookie')
    expect(funcBody).toMatch(/startsWith\(['"]XSRF-TOKEN=/);
    // Must NOT use the broad check that only verified !res.getHeader('Set-Cookie')
    expect(funcBody).not.toMatch(/!res\.getHeader\(['"]Set-Cookie['"]\)/);
  });
});

// =============================================================================
// M4: combineAbortSignals fallback must have a fired flag
// =============================================================================

describe('M4: AbortSignal.any() fallback has fired flag', () => {
  it('combineAbortSignals fallback uses a fired flag to prevent double-abort', () => {
    const content = read('backend/src/lib/ai-client.ts');
    // Find the combineAbortSignals function body
    const funcMatch = content.match(/function combineAbortSignals[\s\S]*?(?=\n\S)/);
    const funcBody = funcMatch ? funcMatch[0]! : '';
    if (funcBody) {
      // The fallback (non-AbortSignal.any path) must have a fired flag
      expect(funcBody).toMatch(/fired/);
      expect(funcBody).toMatch(/let fired = false/);
    }
  });
});

// =============================================================================
// L1: Watchdog must use a Worker pool, not new Worker() per call
// =============================================================================

describe('L1: Watchdog uses Worker pool', () => {
  it('startWatchdog uses a pool instead of creating a new Worker per call', () => {
    const content = read('backend/src/lib/watchdog.ts');
    // Must have a pool mechanism (MAX_WORKERS and _workerPool)
    expect(content).toMatch(/MAX_WORKERS\s*=\s*\d/);
    expect(content).toMatch(/_workerPool/);
    // Must NOT create a new Worker directly in startWatchdog
    const startFunc = content.match(/export function startWatchdog[\s\S]*?(?=\nexport (async )?function|\n\/\*\*)/);
    if (startFunc) {
      expect(startFunc[0]!).not.toMatch(/new Worker\(/);
    }
  });
});
