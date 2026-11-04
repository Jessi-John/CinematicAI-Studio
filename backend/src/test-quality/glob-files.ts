import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Minimal recursive glob used by the test-quality invariant suites.
 *
 * `fs.globSync` is only available in Node.js 22+, but the project supports
 * Node.js 20 and CI runs on Node.js 20. This helper implements the small
 * subset of glob syntax these suites use (`*`, `**`, `?`) without adding a
 * dependency.
 */
export interface GlobOptions {
  cwd: string;
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
]);

function patternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;

    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${source}$`);
}

export function globFiles(pattern: string, options: GlobOptions): string[] {
  const { cwd } = options;
  const matcher = patternToRegExp(pattern);
  const matches: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const relativePath = relative(cwd, absolutePath).split(sep).join('/');
      if (matcher.test(relativePath)) matches.push(relativePath);
    }
  }

  walk(cwd);
  return matches;
}
