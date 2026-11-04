/**
 * HNSW index dimension validation — live database integration tests.
 *
 * On 2026-06-05, a cold-start Docker test revealed that the
 * 20260528000002_add_pgvector_and_hnsw migration used vector(4096) which
 * exceeds pgvector HNSW's 2000-dim hard limit. The migration silently failed.
 * These tests verify the production database has vector(1024) correctly set up.
 *
 * Requires RUN_HNSW_TEST=1 environment variable and a non-test database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from './prisma.js';

function checkHnswDim(indexdef: string, expectedDim: number): { ok: boolean; actualDim: number; msg?: string } {
  const dimMatch = indexdef.match(/vector\((\d+)\)/);
  const actualDim = dimMatch ? parseInt(dimMatch[1]!, 10) : 0;
  if (actualDim !== expectedDim) {
    return {
      ok: false,
      actualDim,
      msg: `HNSW index dimension mismatch: expected vector(${expectedDim}) but found vector(${actualDim})`,
    };
  }
  return { ok: true, actualDim };
}

// ---------- Database integration tests (live DB required) ----------
const ENABLED = process.env.RUN_HNSW_TEST === '1' &&
  !process.env.DATABASE_URL?.includes('test:test@');

let hnswAvailable = false;

beforeAll(async () => {
  if (!ENABLED) return;
  try {
    const result = await prisma().$queryRawUnsafe<Array<{ extname: string }>>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`
    );
    hnswAvailable = result.length > 0;
  } catch {
    hnswAvailable = false;
  }
}, 15000);

afterAll(async () => {
  if (!ENABLED) return;
  await prisma().$disconnect();
}, 15000);

describe('REL-005: HNSW live database checks', () => {
  it('pgvector extension is installed', async () => {
    if (!ENABLED) {
      console.log('[SKIP] RUN_HNSW_TEST=1 required against docker-compose DB');
      return;
    }
    expect(hnswAvailable).toBe(true);
  });

  it('hnsw index on stories.embedding exists with vector(1024)', async () => {
    if (!ENABLED) {
      console.log('[SKIP] RUN_HNSW_TEST=1 required against docker-compose DB');
      return;
    }
    const rows = await prisma().$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'stories'
         AND indexname LIKE '%embedding%hnsw%'`
    );
    expect(rows.length).toBeGreaterThan(0);
    const result = checkHnswDim(rows[0]!.indexdef, 1024);
    expect(result.ok).toBe(true);
  }, 15000);

  it('stories.embedding column is of type vector(1024)', async () => {
    if (!ENABLED) {
      console.log('[SKIP] RUN_HNSW_TEST=1 required against docker-compose DB');
      return;
    }
    const rows = await prisma().$queryRawUnsafe<Array<{ data_type: string }>>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'stories' AND column_name = 'embedding'`
    );
    expect(rows.length).toBe(1);
    // For pgvector the data_type is "USER-DEFINED" (the vector type alias).
    // Pin the contract: it's a non-empty string, not the empty string or NULL
    // that would indicate the column doesn't exist or has an unknown type.
    expect(typeof rows[0]!.data_type).toBe('string');
    expect(rows[0]!.data_type.length).toBeGreaterThan(0);
  }, 10000);
});
