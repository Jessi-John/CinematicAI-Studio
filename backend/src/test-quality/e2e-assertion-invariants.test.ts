/**
 * E2E assertion-quality invariants.
 *
 * The `comprehensive-*` E2E specs removed during the 2026-06-29 audit had
 * two recurring anti-patterns that made them useless as regression guards:
 *
 *   1. `console.log(...)` with no following `expect()` — the test only
 *      reported state instead of asserting on it.
 *   2. Overly broad status-code arrays (e.g. `[201, 409, 429]` or
 *      `[400, 401, 404]`) — the assertion passed no matter which outcome
 *      occurred.
 *
 * This invariant scans `e2e/*.spec.ts` and fails the build if either pattern
 * appears in a `test(...)` / `it(...)` block.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const E2E_DIR = resolve(REPO_ROOT, 'e2e');

interface TestBlock {
  name: string;
  body: string;
  startLine: number;
}

function extractTestBlocks(content: string): TestBlock[] {
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

    // Find the start of the callback (arrow function or function expression).
    let callbackStart = nameEnd + 1;
    while (callbackStart < content.length && /[,\s]/.test(content[callbackStart]!)) {
      callbackStart++;
    }
    if (content[callbackStart] !== '(' && content[callbackStart] !== '{') {
      // Might be an async arrow `async (`. Skip forward a bit.
      const asyncMatch = content.slice(callbackStart).match(/^async\s*[({]/);
      if (!asyncMatch) continue;
      callbackStart += asyncMatch[0].indexOf(asyncMatch[0].match(/[({]/)![0]);
    }

    // Use brace counting to find the end of the callback body.
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

    // Calculate the line number of the test declaration.
    const lineNumber = content.slice(0, startIdx).split('\n').length;
    blocks.push({
      name,
      body: content.slice(bodyStart, bodyEnd),
      startLine: lineNumber,
    });
  }

  return blocks;
}

function hasConsoleLogWithoutExpect(block: TestBlock): boolean {
  const body = block.body;
  if (!/console\.log\s*\(/.test(body)) return false;
  return !/\bexpect\s*\(/.test(body);
}

function hasOverlyBroadStatusAssertion(block: TestBlock): boolean {
  // Match patterns like:
  //   expect([200, 201]).toContain(...)
  //   expect([201, 409, 429]).toContain(...)
  //   expect([400, 401, 404]).toContain(...)
  // We flag any array with 2+ numeric/status-code literals passed to toContain.
  // A deterministic test should know the exact status it expects.
  const regex = /expect\s*\(\s*\[\s*(\d+\s*,\s*){1,}\d+\s*\]\s*\)\s*\.\s*toContain\b/g;
  return regex.test(block.body);
}

describe('E2E assertion-quality invariants', () => {
  const files = globSync('*.spec.ts', { cwd: E2E_DIR });
  const consoleOffenders: { file: string; test: string; line: number }[] = [];
  const statusOffenders: { file: string; test: string; line: number }[] = [];

  for (const file of files) {
    const absolutePath = resolve(E2E_DIR, file);
    const content = readFileSync(absolutePath, 'utf8');
    const blocks = extractTestBlocks(content);

    for (const block of blocks) {
      if (hasConsoleLogWithoutExpect(block)) {
        consoleOffenders.push({ file, test: block.name, line: block.startLine });
      }
      if (hasOverlyBroadStatusAssertion(block)) {
        statusOffenders.push({ file, test: block.name, line: block.startLine });
      }
    }
  }

  it('has no test blocks that console.log without an expect()', () => {
    const messages = consoleOffenders.map(
      (o) => `${o.file}:${o.line} "${o.test}"`
    );
    expect(consoleOffenders).toEqual([]);
    if (messages.length > 0) expect(messages).toEqual([]);
  });

  it('has no status-code assertions with 3+ acceptable codes', () => {
    const messages = statusOffenders.map(
      (o) => `${o.file}:${o.line} "${o.test}"`
    );
    expect(statusOffenders).toEqual([]);
    if (messages.length > 0) expect(messages).toEqual([]);
  });
});
