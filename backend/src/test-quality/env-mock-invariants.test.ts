/**
 * Env-mock invariants for tests.
 *
 * Several backend route tests mock `backend/src/config/env.js` to provide
 * stable secrets and avoid `exit(1)` on validation. If the mock drifts from
 * the actual `RequiredEnv & OptionalEnv` interface in `env.ts`, the test may
 * still pass but no longer represents the real runtime environment.
 *
 * This invariant catches tests that mock obsolete provider env keys that no
 * longer exist in `env.ts`, which would silently drift from the real runtime.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globFiles } from './glob-files.js';
import { resolve } from 'node:path';

const SRC_ROOT = resolve(__dirname, '..');
const TEST_ROOT = resolve(__dirname, '..');

interface EnvShape {
  required: Set<string>;
  optional: Set<string>;
  obsolete: Set<string>;
}

function loadEnvShape(): EnvShape {
  const src = readFileSync(resolve(SRC_ROOT, 'config', 'env.ts'), 'utf8');

  const requiredMatch = src.match(/export\s+interface\s+RequiredEnv\s*\{([^}]+)\}/s);
  const optionalMatch = src.match(/export\s+interface\s+OptionalEnv\s*\{([^}]+)\}/s);

  const extractKeys = (block: string | undefined): Set<string> => {
    const keys = new Set<string>();
    if (!block) return keys;
    const lines = block.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*):/);
      if (m) keys.add(m[1]!);
    }
    return keys;
  };

  return {
    required: extractKeys(requiredMatch?.[1]),
    optional: extractKeys(optionalMatch?.[1]),
    // No provider env keys are currently considered obsolete. When a provider
    // is removed, add its keys here so any test that keeps mocking them fails.
    obsolete: new Set([]),
  };
}

interface EnvMock {
  keys: string[];
  block: string;
}

function extractMockedEnvKeys(content: string): EnvMock | null {
  // Match any vi.mock('../config/env.js', ...) block. Tests use several styles:
  //   - vi.mock('...', () => ({ validateAndLoadEnv: vi.fn().mockReturnValue({ ... }) }))
  //   - vi.mock('...', () => ({ getApiSecret: vi.fn(() => '...') }))
  //   - vi.mock('...', () => ({ KEY: 'value', ... }))
  // We locate the entire vi.mock(...) call, then extract every uppercase env-key
  // assignment inside it. That covers all of the above without requiring a single
  // mock style.
  const marker = /vi\.mock\s*\(\s*['"`][^'"`]*config\/env\.js['"`]/s;
  const markerMatch = content.match(marker);
  if (!markerMatch) return null;

  const startIdx = markerMatch.index!;
  let i = startIdx;
  // Move to the opening paren of vi.mock(...)
  while (i < content.length && content[i] !== '(') i++;

  let depth = 0;
  let inString: string | null = null;
  let bodyStart = -1;
  while (i < content.length) {
    const ch = content[i];
    const prev = content[i - 1];

    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
    } else if (ch === '(') {
      depth++;
      if (depth === 1) bodyStart = i + 1;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const block = content.slice(bodyStart, i);
        const keys: string[] = [];
        const keyRegex = /\b([A-Z_][A-Z0-9_]*)\s*:/g;
        let km: RegExpExecArray | null;
        while ((km = keyRegex.exec(block)) !== null) {
          keys.push(km[1]!);
        }
        return { keys, block };
      }
    }
    i++;
  }

  return null;
}

describe('Env-mock invariants', () => {
  const shape = loadEnvShape();
  // TEST_ROOT already IS backend/src — the glob must not prepend another src/.
  const files = globFiles('**/*.test.ts', { cwd: TEST_ROOT });
  const offenders: { file: string; missing: string[]; obsolete: string[] }[] = [];

  // C1 self-guard: a broken glob root must fail loudly, not vacuously pass.
  it('harness sanity: the scan actually found test files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    // Skip self: this file's own comments contain literal `vi.mock('...config/env.js'`
    // examples that the marker regex would match, producing a false positive.
    if (file.replace(/\\/g, '/').endsWith('test-quality/env-mock-invariants.test.ts')) continue;
    const absolutePath = resolve(TEST_ROOT, file);
    const content = readFileSync(absolutePath, 'utf8');
    const envMock = extractMockedEnvKeys(content);
    if (!envMock) continue;

    const keySet = new Set(envMock.keys);
    const missing: string[] = [];
    for (const req of shape.required) {
      if (!keySet.has(req)) missing.push(req);
    }

    const obsolete: string[] = [];
    for (const key of envMock.keys) {
      if (shape.obsolete.has(key)) obsolete.push(key);
      else if (!shape.required.has(key) && !shape.optional.has(key)) {
        // Allow extra keys that are read directly via process.env (e.g.
        // BCRYPT_ROUNDS). Only flag known-obsolete keys as errors.
      }
    }

    if (missing.length > 0 || obsolete.length > 0) {
      offenders.push({ file: file.replace(/\\/g, '/'), missing, obsolete });
    }
  }

  it('tests mocking config/env.js must include all RequiredEnv keys and no obsolete keys', () => {
    const messages = offenders.flatMap((o) => {
      const parts: string[] = [];
      if (o.missing.length > 0) parts.push(`missing ${o.missing.join(', ')}`);
      if (o.obsolete.length > 0) parts.push(`obsolete ${o.obsolete.join(', ')}`);
      return `${o.file}: ${parts.join('; ')}`;
    });
    expect(offenders).toEqual([]);
    if (messages.length > 0) {
      expect(messages).toEqual([]);
    }
  });
});
