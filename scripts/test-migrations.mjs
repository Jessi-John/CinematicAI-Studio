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
 * Requires: DATABASE_URL env var pointing to a throwaway test database.
 * Note: `prisma migrate diff --from-migrations` also requires a SHADOW
 * database (Prisma creates one automatically on Postgres; on restricted
 * hosts set SHADOW_DATABASE_URL).
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
  console.log('\n=== Verifying schema drift ===');
  run('npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code');

  console.log('\n=== Migration integrity check PASSED ===');
} catch {
  console.error('\n=== Migration integrity check FAILED ===');
  console.error('Migration deploy or the drift check failed — see the output above for the root cause.');
  console.error('If migrations are out of sync, run `npx prisma migrate dev` locally to generate the missing migration.');
  process.exit(1);
}
