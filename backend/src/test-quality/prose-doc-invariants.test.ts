/**
 * Prose / documentation invariants.
 *
 * Stale terminology and obsolete env vars have a way of creeping back into
 * docs, config, and shell scripts after they are removed from code. This
 * invariant scans prose/config files and fails CI if any forbidden pattern
 * appears outside an explicitly documented allowlist.
 *
 * The allowlist is intentional and narrow. If you need to add a new entry,
 * document the reason right next to it. Historical changelogs are allowed to
 * mention old terms; current documentation is not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, lstatSync } from 'node:fs';
import { globFiles } from './glob-files.js';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const FORBIDDEN_PATTERNS = [
  { name: 'ADMIN_PASSWORD env assignment', regex: /\bADMIN_PASSWORD\s*=/ },
  { name: 'ADMIN_PASSWORD code reference', regex: /process\.env\.ADMIN_PASSWORD\b/ },
  { name: 'ADMIN_PASSWORD_HASH', regex: /\bADMIN_PASSWORD_HASH\b/ },
  { name: 'NVIDIA API as current provider', regex: /\bNVIDIA API\b/ },
  { name: 'PHASE-* stage prefix', regex: /\bPHASE-\d+\b/ },
  // C1: Real-looking API keys in .env files (sk- prefix). The
  // isPlaceholder() check in env.ts does NOT catch sk-* format keys,
  // so a .env file with real credentials would pass validation.
  // The pre-commit hook blocks commits with real secrets, but this
  // invariant catches any sk- key that ended up in the repo anyway.
  { name: 'sk- API key in .env', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // F1 (eng review 2026-09-27): stale circuit-breaker claims. The breaker is
  // configured in ai-client.ts with threshold: 5 and resetTimeout: 60000
  // (doubling to a 30min cap). Docs claiming 3 failures / 30s reset are wrong
  // and have sent operators to the wrong numbers during incident review.
  { name: 'Stale circuit breaker threshold (3 failures)', regex: /3 consecutive failures|opens? after 3 failures|3 failures → open/ },
  // PERF-LIST-TOTAL companion: the old "pool size 2" claim contradicted
  // prisma.ts (default 10, DB_CONNECTION_LIMIT tunable).
  { name: 'Stale DB pool claim (size 2)', regex: /Connection pool size 2|pool size of 2\b/ },
];

const SCANNED_GLOBS = [
  '**/*.md',
  '**/*.yml',
  '**/*.yaml',
  '**/*.sh',
  '**/*.json',
  'backend/src/**/*.ts',
  'backend/src/**/*.js',
  'eslint-plugins/**/*',
  'scripts/**/*',
  'deploy/**/*',
  // C1: Check .env files for real API keys (sk- prefix).
  // .env.example and .env are not gitignored; .env is in .gitignore
  // but can leak via tarballs, CI artifacts, or screenshots.
  '.env',
  '.env.example',
  '.env.*',
];

const EXCLUDED_DIRS = [
  'node_modules',
  'backend/node_modules',
  'backend/dist',
  '.next',
  '.git',
];

interface AllowlistEntry {
  file: string;
  line: number;
  pattern: string;
  reason: string;
}

/**
 * Allowlisted occurrences. Every entry must include a reason. The file path
 * is relative to the repo root and uses forward slashes.
 */
const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'backend/src/test-quality/env-mock-invariants.test.ts',
    line: 1,
    pattern: '*',
    reason: 'This invariant test intentionally lists obsolete env keys so it can reject them elsewhere.',
  },
  {
    file: 'backend/src/test-quality/prose-doc-invariants.test.ts',
    line: 1,
    pattern: '*',
    reason: 'This invariant test defines the forbidden patterns it scans for.',
  },
  {
    file: '.env',
    line: 0,
    pattern: 'sk- API key in .env',
    reason: '.env is gitignored and local-only. Production secrets live in Docker secret files or the Windows Credential Manager; this file is allowed to contain real keys for local dev.',
  },
  {
    file: 'backend/src/config/env.test.ts',
    line: 0,
    pattern: 'sk- API key in .env',
    reason: 'Test file uses sk- values as placeholder test data for the isPlaceholder() validation tests.',
  },
  {
    file: 'backend/src/lib/ai-client.test.ts',
    line: 0,
    pattern: 'sk- API key in .env',
    reason: 'Test file uses sk- prefixed strings as test data for API key validation logic.',
  },
  {
    file: 'backend/src/lib/ai-client.provider-order.test.ts',
    line: 0,
    pattern: 'sk- API key in .env',
    reason: 'Test file uses sk- prefixed strings as test data for API key validation logic.',
  },
];

function isExcluded(path: string): boolean {
  return EXCLUDED_DIRS.some((dir) =>
    path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`)
  );
}

function isAllowlisted(
  relPath: string,
  line: number,
  patternName: string
): boolean {
  return ALLOWLIST.some((entry) => {
    const normalizedEntryFile = entry.file.replace(/\\/g, '/');
    const normalizedRelPath = relPath.replace(/\\/g, '/');
    if (normalizedEntryFile !== normalizedRelPath) return false;
    if (entry.pattern === '*') return true;
    // A line number of 0 means "any line" — the allowlist entry matches the
    // pattern anywhere in the file. This avoids brittle line-number drift.
    const lineMatches = entry.line === 0 || line === entry.line;
    return entry.pattern === patternName && lineMatches;
  });
}

interface Offense {
  file: string;
  line: number;
  pattern: string;
}

describe('Prose / documentation invariants', () => {
  const offenders: Offense[] = [];

  for (const pattern of SCANNED_GLOBS) {
    const files = globFiles(pattern, { cwd: REPO_ROOT });
    for (const file of files) {
      const rel = file.replace(/\\/g, '/');
      if (isExcluded(rel)) continue;

      const absolutePath = resolve(REPO_ROOT, file);
      if (!lstatSync(absolutePath).isFile()) continue;
      const content = readFileSync(absolutePath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.regex.test(lines[i]!)) {
            if (!isAllowlisted(rel, lineNumber, forbidden.name)) {
              offenders.push({ file: rel, line: lineNumber, pattern: forbidden.name });
            }
          }
        }
      }
    }
  }

  it('has no stale terminology or obsolete env vars outside the allowlist', () => {
    const messages = offenders.map(
      (o) => `${o.file}:${o.line} ${o.pattern}`
    );
    expect(offenders).toEqual([]);
    if (messages.length > 0) expect(messages).toEqual([]);
  });
});
