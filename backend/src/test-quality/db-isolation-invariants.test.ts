/**
 * DB-isolation invariants for tests.
 *
 * Services that eventually call `prisma()` must not be exercised in unit
 * tests without mocking `database/prisma.js` or `services/generation-logger.js`.
 * Otherwise the test tries to connect to the DATABASE_URL host and either
 * times out or prints Prisma connection errors while "passing" because the
 * catch block swallows the failure.
 *
 * This invariant catches the pattern that broke `worker.fallback.test.ts`
 * during the 2026-06-29 audit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

const SRC_ROOT = resolve(__dirname, '..');
const TEST_ROOT = resolve(__dirname, '..');

/**
 * Services and database modules that call `prisma()` either directly or
 * via generation-logger. Importing any of these in a test without mocking
 * prisma/generation-logger risks real DB access.
 *
 * This list is intentionally broad: any module that performs DB reads or
 * writes is a DB-touching dependency, even if the test only uses a helper
 * function that happens to be co-located in the same file.
 */
const DB_TOUCHING_MODULES: Record<string, string> = {
  'database/prisma.js': 'prisma()',
  'database/prisma-storage.js': 'DB storage helpers',
  'services/character-bible.js': 'generateCharacterBible',
  'services/episode-regeneration.js': 'episode regeneration',
  'services/generation-logger.js': 'logFallback/logGeneration',
  'services/scene-regeneration.js': 'scene regeneration',
  'services/similarity.js': 'similarity checks',
  'services/story-regeneration.js': 'story regeneration',
  'services/uniqueness.js': 'title uniqueness',
  'services/user-settings.js': 'user settings',
  'services/world-bible.js': 'generateWorldBible',
};

function resolveImportPath(importPath: string, testFileDir: string): string | null {
  // Only handle project-relative imports (ignore npm packages).
  if (!importPath.startsWith('.')) return null;
  const resolved = resolve(testFileDir, importPath);
  const rel = resolved.replace(SRC_ROOT + sep, '').replace(/\\/g, '/');
  return rel;
}

function isDbTouchingImport(importPath: string): boolean {
  return Object.keys(DB_TOUCHING_MODULES).some((mod) => importPath.includes(mod));
}

function hasDbMock(content: string): boolean {
  // Accepted isolation strategies:
  //  1. vi.mock of prisma.js / generation-logger.js (direct module mock)
  //  2. vi.mock of prisma-storage.js (storage-layer mock — all DB access flows through it)
  //  3. __setClient injection (prisma.ts's built-in test client injection)
  if (/vi\.mock\s*\(\s*['"`][^'"`]*(?:prisma|generation-logger|prisma-storage)\.js['"`]/s.test(content)) return true;
  if (/__setClient/.test(content)) return true;
  return false;
}

/**
 * Files allowed to import DB-touching modules without a mock, with justification:
 * - schema-audit / server.hnsw-dim: live-DB integration tests, env-gated
 *   (RUN_SCHEMA_SYNC=1 / RUN_HNSW_TEST=1) so they are inert in the unit suite.
 * - similarity / uniqueness: pure-function tests; `prisma()` is lazy and is
 *   never invoked by the functions under test.
 */
const ALLOWLIST_NO_MOCK = new Set<string>([
  'database/schema-audit.test.ts',
  'database/server.hnsw-dim.test.ts',
  'services/similarity.test.ts',
  'services/uniqueness.test.ts',
]);

describe('DB-isolation invariants', () => {
  // TEST_ROOT already IS backend/src — the glob must not prepend another src/.
  const files = globSync('**/*.test.ts', { cwd: TEST_ROOT });
  const offenders: { file: string; imports: string[] }[] = [];

  // C1 self-guard: a broken glob root must fail loudly, not vacuously pass.
  it('harness sanity: the scan actually found test files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relFile = file.replace(/\\/g, '/');
    if (ALLOWLIST_NO_MOCK.has(relFile)) continue;
    const absolutePath = resolve(TEST_ROOT, file);
    const rawContent = readFileSync(absolutePath, 'utf8');

    if (hasDbMock(rawContent)) continue;

    // Strip `import type` lines — type-only imports are erased at compile time
    // and can never reach the DB.
    const content = rawContent.replace(/^\s*import\s+type\s+.*$/gm, '');

    const testDir = dirname(absolutePath);
    const importRegex = /import\s+.*?\s+from\s+(['"`][^'"`]+['"`])|import\s*\(\s*(['"`][^'"`]+['"`])\s*\)/g;
    const badImports: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const rawPath = (match[1] ?? match[2] ?? '').replace(/['"`]/g, '');
      const resolved = resolveImportPath(rawPath, testDir);
      if (resolved && isDbTouchingImport(resolved)) {
        badImports.push(resolved);
      }
    }

    if (badImports.length > 0) {
      offenders.push({ file: relFile, imports: badImports });
    }
  }

  it('tests importing DB-touching services must mock prisma.js or generation-logger.js', () => {
    const messages = offenders.map(
      (o) => `${o.file} imports ${o.imports.join(', ')} without a prisma/generation-logger mock`
    );
    expect(offenders).toEqual([]);
    if (messages.length > 0) {
      // This line is unreachable when the assertion above passes, but it
      // improves the failure message if the assertion is ever relaxed.
      expect(messages).toEqual([]);
    }
  });
});
