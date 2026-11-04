import { PrismaClient } from '@prisma/client';
import { validateAndLoadEnv } from '../config/env.js';
import { logger } from '../services/logger.js';

const g = globalThis as unknown as { prisma?: PrismaClient };

function buildClient(): PrismaClient {
  const rawUrl = validateAndLoadEnv().DATABASE_URL;
  const base = rawUrl.split('?')[0];

  // Fix: Preserve existing query parameters from DATABASE_URL (e.g. sslmode=require,
  // schema=public). Splitting on '?' and discarding everything after silently drops
  // these critical connection properties. We now parse the existing params, merge
  // our managed ones, and reconstruct the query string.
  const existingParams = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] ?? '' : '');

  // Allow pool tuning via env vars. DB_CONNECTION_LIMIT overrides the default of 10.
  // BUG-001: The previous default of 5 was too small for the worker pipeline —
  // with 2 concurrent story-generation jobs, each holding 2-3 long-running
  // transactions (episode + scene + character upserts), the backend's 5-conn
  // pool was exhausted on every burst, producing P2024 timeouts that cascaded
  // into process shutdown (fixed in BUG-002). 10 per process is enough for
  // the typical request burst + BullMQ background work; tune via env.
  // MEDIUM #37: Clamp pool parameters to safe bounds and log when clamped.
  function clampInt(raw: string | undefined, defaultValue: number, min: number, max: number, name: string): number {
    const parsed = parseInt(raw || String(defaultValue), 10);
    if (Number.isNaN(parsed)) {
      logger.warn({ name, raw, defaultValue }, 'Invalid integer env value; using default');
      return defaultValue;
    }
    if (parsed < min || parsed > max) {
      logger.warn({ name, raw, parsed, min, max, clamped: Math.min(max, Math.max(min, parsed)) }, 'Env value out of bounds; clamping');
      return Math.min(max, Math.max(min, parsed));
    }
    return parsed;
  }
  const connectionLimit = clampInt(process.env.DB_CONNECTION_LIMIT, 10, 1, 100, 'DB_CONNECTION_LIMIT');
  const poolTimeout = clampInt(process.env.DB_POOL_TIMEOUT, 10, 1, 300, 'DB_POOL_TIMEOUT');
  const connectionTimeout = clampInt(process.env.DB_CONNECT_TIMEOUT, 5, 1, 60, 'DB_CONNECT_TIMEOUT');

  // M4 — Add pgbouncer=true for PgBouncer-compatible connection pooling.
  // Prisma's internal pool management differs when pgbouncer=true is set:
  // it disables prepared statements (PgBouncer doesn't support them in
  // transaction mode) and uses a simpler connection lifecycle. This is safe
  // even without PgBouncer — Prisma falls back to direct connections.
  const pgbouncer = process.env.DB_PGBOUNCER_MODE === 'true' ? 'true' : 'false';
  const statementTimeout = clampInt(process.env.DB_STATEMENT_TIMEOUT, 10000, 1000, 300000, 'DB_STATEMENT_TIMEOUT');

  // Merge managed params over existing ones (managed take precedence).
  // NOTE: DATABASE_URL passwords containing '?' must be percent-encoded —
  // the split on '?' at line 9 would otherwise truncate the auth section.
  existingParams.set('connection_limit', String(connectionLimit));
  existingParams.set('pool_timeout', String(poolTimeout));
  existingParams.set('connection_timeout', String(connectionTimeout));
  existingParams.set('statement_timeout', String(statementTimeout));
  existingParams.set('pgbouncer', pgbouncer);
  const mergedParams = existingParams.toString();
  // mergedParams always contains the managed keys — never empty.
  const finalUrl = `${base}?${mergedParams}`;

  return new PrismaClient({
    datasources: { db: { url: finalUrl } },
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });
}

// Lazy getter: PrismaClient is only instantiated on first call, not at import time.
// This prevents real DB connections during test module evaluation.
export function prisma(): PrismaClient {
  if (!g.prisma) {
    g.prisma = buildClient();
  }
  return g.prisma;
}

// Test-only: allow tests to inject a mock client before first use.
// Safe because prisma() is always called inside request handlers, not at module load.
export function __setClient(client: PrismaClient): void {
  g.prisma = client;
}

export async function testConnection(): Promise<void> {
  try {
    await prisma().$connect();
    logger.info('Database connected');
  } catch (err) {
    logger.error({ err }, 'Database connection failed');
    throw err;
  }
}
