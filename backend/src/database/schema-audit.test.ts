/**
 * M7 — Regression test for schema.prisma ↔ database sync.
 *
 * Reads all model/column definitions from schema.prisma and verifies they
 * exist in the live database. Catches the "schema updated without migration"
 * anti-pattern that silently drops pgvector HNSW indexes and @updatedAt
 * columns.
 *
 * Gated behind RUN_SCHEMA_SYNC=1 so it only
 * runs against the real docker-compose database, not the vitest test DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './prisma.js';

const ENABLED = process.env.RUN_SCHEMA_SYNC === '1' && !process.env.DATABASE_URL?.includes('test:test@');

let schema: string;

beforeAll(async () => {
  if (!ENABLED) return;
  schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8'
  );
});

afterAll(async () => {
  if (!ENABLED) return;
  await prisma().$disconnect();
});

/** Parse model names and their column names from schema.prisma. */
function parseModels(text: string): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  const knownModelNames = new Set<string>();
  // First pass: collect all model names
  const nameRe = /model (\w+) \{/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    knownModelNames.add(m[1]!);
  }

  // Second pass: parse columns
  const modelRe = /model (\w+) \{([^}]+)\}/g;
  while ((m = modelRe.exec(text)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const cols: string[] = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      // Skip comments, decorators, relation fields
      if (trimmed.startsWith('//') || trimmed.startsWith('@@') || trimmed.startsWith('@')) continue;
      const col = trimmed.match(/^(\w+)\s+(\w+(\[\])?)/);
      if (!col) continue;
      const fieldName = col[1]!;
      const fieldType = col[2]!.replace('[]', '');
      // Skip relation fields (type matches another model name).
      // Prisma scalar types (String, Int, Float, Boolean, DateTime, Json)
      // also start with uppercase, so we must explicitly check knownModelNames.
      if (knownModelNames.has(fieldType)) continue;
      cols.push(fieldName);
    }
    models[name] = cols;
  }
  return models;
}

/** Build the @map table name lookup. */
function buildTableMap(text: string, models: Record<string, string[]>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const model of Object.keys(models)) {
    const re = new RegExp(`model ${model} \\{[^}]+@@map\\("(\\w+)"\\)`);
    const m = text.match(re);
    map[model] = m ? m[1]! : model.toLowerCase() + 's';
  }
  return map;
}

describe('M7: schema.prisma ↔ database sync', () => {
  test('schema.prisma file parses correctly', () => {
    schema = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8'
    );
    const models = parseModels(schema);
    expect(Object.keys(models).length).toBeGreaterThan(0);
    // Core models that must always be present (model names match schema.prisma casing)
    expect(models).toHaveProperty('User');
    expect(models).toHaveProperty('Story');
    expect(models).toHaveProperty('Episode');
    expect(models).toHaveProperty('Scene');
    expect(models).toHaveProperty('Character');
    expect(models).toHaveProperty('Environment');
    expect(models).toHaveProperty('YouTubeSEO');
  });

  test('all tables in schema exist in database', async () => {
    if (!ENABLED) {
      console.log('[SKIP] set RUN_SCHEMA_SYNC=1 against docker-compose DB to enable');
      return;
    }

    const models = parseModels(schema);
    const tableMap = buildTableMap(schema, models);
    let missingCount = 0;

    for (const [model, tableName] of Object.entries(tableMap)) {
      const result = await prisma().$queryRawUnsafe<Array<{ exists: boolean }>>(
        `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`,
        tableName
      );
      if (!result[0]?.exists) {
        console.log(`  TABLE MISSING: ${model} (${tableName})`);
        missingCount++;
      }
    }

    expect(missingCount).toBe(0);
  }, 60000);

  test('all columns in schema exist in database', async () => {
    if (!ENABLED) {
      console.log('[SKIP] set RUN_SCHEMA_SYNC=1 against docker-compose DB to enable');
      return;
    }

    const models = parseModels(schema);
    const tableMap = buildTableMap(schema, models);
    let totalMissing = 0;

    for (const [model, cols] of Object.entries(models)) {
      const tableName = tableMap[model];
      if (!tableName) continue;

      const dbCols = await prisma().$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        tableName
      );
      const dbColNames = new Set(dbCols.map((c) => c.column_name));

      for (const col of cols) {
        if (!dbColNames.has(col)) {
          console.log(`  COLUMN MISSING: ${tableName}.${col}`);
          totalMissing++;
        }
      }
    }

    expect(totalMissing).toBe(0);
  }, 60000);

  test('pgvector HNSW index exists on stories.embedding', async () => {
    if (!ENABLED) {
      console.log('[SKIP] set RUN_SCHEMA_SYNC=1 against docker-compose DB to enable');
      return;
    }

    const result = await prisma().$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'stories'
         AND indexname LIKE '%embedding%'
         AND indexname LIKE '%hnsw%'
       LIMIT 1`
    );
    expect(result.length).toBe(1);
    expect(result[0]!.indexname).toMatch(/hnsw/i);
  }, 30000);

  test('pgvector HNSW index uses vector(1024)', async () => {
    if (!ENABLED) {
      console.log('[SKIP] set RUN_SCHEMA_SYNC=1 against docker-compose DB to enable');
      return;
    }

    const result = await prisma().$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'stories'
         AND indexname LIKE '%hnsw%'
         AND indexname LIKE '%embedding%'
       LIMIT 1`
    );
    expect(result.length).toBe(1);
    const dimMatch = result[0]!.indexdef.match(/vector\((\d+)\)/);
    expect(dimMatch).not.toBeNull();
    expect(parseInt(dimMatch![1]!, 10)).toBe(1024);
  }, 30000);
});
