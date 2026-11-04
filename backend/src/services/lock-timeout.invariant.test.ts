/**
 * H12 regression guard: `lock_timeout` must be set with SET LOCAL, never
 * session-scoped SET. A session-scoped SET survives COMMIT on a pooled
 * connection and silently applies a 5s lock_timeout to unrelated queries
 * (and, under PgBouncer transaction pooling, to other clients).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILES = [
  'src/services/episode-regeneration.ts',
  'src/services/scene-regeneration.ts',
];

describe('H12 — lock_timeout is transaction-scoped', () => {
  for (const file of FILES) {
    it(`${file} uses SET LOCAL lock_timeout`, () => {
      const content = readFileSync(resolve(__dirname, '..', '..', file), 'utf8');
      const matches = content.match(/SET( LOCAL)? lock_timeout/g) ?? [];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m).toBe('SET LOCAL lock_timeout');
      }
    });
  }
});
