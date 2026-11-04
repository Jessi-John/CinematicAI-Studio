/**
 * Backend assertion-quality invariants.
 *
 * Integration/route tests sometimes use overly broad status-code arrays such as
 * `[200, 400, 404, 500]` or `[200, 201, 503]`. A 5xx means the server crashed
 * or a dependency failed; tests should NEVER treat that as an acceptable
 * outcome. Arrays with three or more possible statuses are also too broad —
 * they pass no matter which outcome occurs and do not guard against
 * regressions. These assertions are a symptom of non-deterministic fixtures
 * or mocks that are not set up for the test.
 *
 * This invariant scans all backend test files and fails the build if any
 * `test(...)` / `it(...)` block asserts `expect([...]).toContain(...)` with an
 * array that either contains a 5xx code or lists two or more acceptable
 * statuses. Even `[200, 201]` is too broad because it accepts either outcome
 * without asserting which one is correct.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND_SRC_DIR = resolve(REPO_ROOT, 'src');

interface TestBlock {
  name: string;
  body: string;
  startLine: number;
  file: string;
}

/**
 * Specific test blocks that are allowed to assert on multiple status codes.
 * Each entry must document why the variation is environmental rather than
 * a regression hole.
 */
const ALLOWLIST = new Set<string>([
  // metrics.test.ts: IPv6 loopback and hostname resolution behavior varies
  // by OS / Node.js version, so these tests document the accepted range.
  'routes/metrics.test.ts:176',
  'routes/metrics.test.ts:182',
  'routes/metrics.test.ts:211',
]);

function extractTestBlocks(content: string, file: string): TestBlock[] {
  const blocks: TestBlock[] = [];
  const regex = /\b(test|it)\s*\(\s*['"`]/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index;
    const quote = content[match.index + match[0].length - 1]!;
    const nameStart = match.index + match[0].length;
    const nameEnd = content.indexOf(quote, nameStart);
    if (nameEnd === -1) continue;
    const name = content.slice(nameStart, nameEnd);

    let callbackStart = nameEnd + 1;
    while (callbackStart < content.length && /[,\s]/.test(content[callbackStart]!)) {
      callbackStart++;
    }
    if (content[callbackStart] !== '(' && content[callbackStart] !== '{') {
      const asyncMatch = content.slice(callbackStart).match(/^async\s*[({]/);
      if (!asyncMatch) continue;
      callbackStart += asyncMatch[0].indexOf(asyncMatch[0].match(/[({]/)![0]);
    }

    let i = callbackStart;
    let openParens = 0;
    let openBraces = 0;
    let inString: string | null = null;
    let bodyStart = -1;
    let bodyEnd = -1;

    while (i < content.length) {
      const ch = content[i];
      const prev = content[i - 1];

      if (inString) {
        if (ch === inString && prev !== '\\') inString = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
      } else if (ch === '(') {
        openParens++;
      } else if (ch === ')') {
        openParens--;
      } else if (ch === '{') {
        openBraces++;
        if (openBraces === 1 && openParens === 0) {
          bodyStart = i + 1;
        }
      } else if (ch === '}') {
        openBraces--;
        if (openBraces === 0 && bodyStart !== -1) {
          bodyEnd = i;
          break;
        }
      }
      i++;
    }

    if (bodyStart === -1 || bodyEnd === -1) continue;

    const lineNumber = content.slice(0, startIdx).split('\n').length;
    blocks.push({
      name,
      body: content.slice(bodyStart, bodyEnd),
      startLine: lineNumber,
      file: file.replace(/\\/g, '/'),
    });
  }

  return blocks;
}

function hasBroadStatusAssertion(block: TestBlock): boolean {
  // Match expect([<codes>]).toContain(...) and extract the numeric codes.
  const regex = /expect\s*\(\s*\[\s*((?:\d+\s*,\s*)+\d+)\s*\]\s*\)\s*\.\s*toContain\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(block.body)) !== null) {
    const codes = match[1]!.split(',').map((s) => parseInt(s.trim(), 10));
    if (codes.some((c) => c >= 500)) return true;
    if (codes.length >= 2) return true;
  }
  return false;
}

describe('Backend assertion-quality invariants', () => {
  const files = globSync('**/*.test.ts', { cwd: BACKEND_SRC_DIR });
  const offenders: { file: string; test: string; line: number }[] = [];

  for (const file of files) {
    const absolutePath = resolve(BACKEND_SRC_DIR, file);
    const content = readFileSync(absolutePath, 'utf8');
    const blocks = extractTestBlocks(content, file);

    for (const block of blocks) {
      if (hasBroadStatusAssertion(block)) {
        const key = `${block.file}:${block.startLine}`;
        if (!ALLOWLIST.has(key)) {
          offenders.push({ file: block.file, test: block.name, line: block.startLine });
        }
      }
    }
  }

  it('has no test blocks with overly broad status-code arrays', () => {
    const messages = offenders.map(
      (o) => `${o.file}:${o.line} "${o.test}"`
    );
    expect(offenders).toEqual([]);
    if (messages.length > 0) expect(messages).toEqual([]);
  });
});
