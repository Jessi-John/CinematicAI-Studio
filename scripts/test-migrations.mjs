/**
 * Migration integrity test — runs on every CI pipeline to catch bad
 * migrations before they reach production.
 *
 * 1. Connects to a test PostgreSQL database
 * 2. Applies all pending migrations via `prisma migrate deploy`
 * 3. Verifies no schema drift via `prisma migrate diff`
 * 4. Exits non-zero if any step fails
 *
 * Usage: node scripts/test-migrations.mjs
 * Requires: DATABASE_URL env var pointing to a throwaway test database, and
 * SHADOW_DATABASE_URL env var for the `prisma migrate diff --from-migrations`
 * shadow database (Prisma requires it explicitly for migration-dir diffs).
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// M61: new URL(...).pathname yields '/D:/youtube/backend' on Windows, which
// spawn() cannot use as cwd (ENOENT). fileURLToPath is the correct API.
const BACKEND_DIR = fileURLToPath(new URL('../backend', import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required and must point to a throwaway database.');
  process.exit(2);
}
if (!process.env.SHADOW_DATABASE_URL) {
  console.error('SHADOW_DATABASE_URL is required: `prisma migrate diff --from-migrations` replays the migration directory into a separate shadow database.');
  process.exit(2);
}
const SHADOW_DATABASE_URL = process.env.SHADOW_DATABASE_URL;

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: BACKEND_DIR, ...opts });
}

try {
  // Step 1: Apply all pending migrations
  console.log('\n=== Applying migrations ===');
  run('npx prisma migrate deploy');

  // Step 2: Verify schema is up to date (no drift)
  // `prisma migrate diff` compares the shadow DB (from migrations) with
  // the Prisma schema. If they differ, a migration is missing or the
  // schema.prisma has un-migrated changes.
  //
  // Raw-SQL-only objects are tolerated: the Prisma DSL cannot express
  // operator classes, so `stories_title_trgm_idx` (GIN, gin_trgm_ops) is
  // created by migrations for trigram search and is intentionally absent
  // from schema.prisma.
  console.log('\n=== Verifying schema drift ===');
  const diff = execSync(
    `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url '${SHADOW_DATABASE_URL}' --script`,
    { cwd: BACKEND_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const unexplained = diff
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .filter((line) => line !== 'DROP INDEX "stories_title_trgm_idx";');
  if (unexplained.length > 0) {
    console.error(diff);
    throw new Error(`Schema drift detected (${unexplained.length} statement(s)): ${unexplained.join(' ')}`);
  }

  console.log('\n=== Migration integrity check PASSED ===');
} catch (error) {
  console.error('\n=== Migration integrity check FAILED ===');
  console.error(error && error.message ? error.message : error);
  console.error('Migration deploy or the drift check failed — see the output above for the root cause.');
  console.error('If migrations are out of sync, run `npx prisma migrate dev` locally to generate the missing migration.');
  process.exit(1);
}
