/**
 * Clean up test users created by E2E tests.
 *
 * E2E tests register users with prefixes like `e2e_`, `testuser_`, `stories_test_`
 * but never delete them. Over time this bloats the users table and slows auth queries.
 *
 * This script deletes all users whose username matches one of the known test prefixes.
 * Run after test suites, or schedule via cron:
 *
 *   # Run every Sunday at 3am
 *   0 3 * * 0 cd /app && npx tsx src/scripts/cleanup-test-users.ts
 *
 * Usage: npx tsx src/scripts/cleanup-test-users.ts
 */

import { prisma } from '../database/prisma.js';
import { writeAuditLog } from '../services/audit-log.js';

// E2E tests register users with these prefixes but never delete them.
// The 'debug_' prefix is used by ad-hoc curl-based manual tests.
// The 'events_test_' prefix is used by the events SSE test suite.
// Keep this list in sync with any test suite that creates users.
const TEST_PREFIXES = [
  'e2e_',
  'testuser_',
  'stories_test_',
  'debug_',
  'events_test_',
  'bench_',
];

async function main() {
  // L: destructive script — require an explicit opt-in and a non-production
  // environment so it can never run against a production database by accident.
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production' && process.env.ALLOW_TEST_USER_CLEANUP !== 'true') {
    throw new Error('cleanup-test-users is disabled in production (set ALLOW_TEST_USER_CLEANUP=true to override)');
  }
  const dryRun = process.argv.includes('--dry-run');
  const before = await prisma().user.count();
  console.log(`[cleanup-test-users] Total users before: ${before}${dryRun ? ' (dry run)' : ''}`);

  let totalDeleted = 0;
  for (const prefix of TEST_PREFIXES) {
    let count: number;
    if (dryRun) {
      count = await prisma().user.count({ where: { username: { startsWith: prefix } } });
    } else {
      const result = await prisma().user.deleteMany({
        where: {
          username: { startsWith: prefix },
        },
      });
      count = result.count;
    }
    if (count > 0) {
      console.log(`[cleanup-test-users] ${dryRun ? 'Would delete' : 'Deleted'} ${count} users with prefix '${prefix}'`);
      if (!dryRun) {
        // M29: audit bulk deletions.
        await writeAuditLog({
          action: 'DELETE',
          entityType: 'bulk',
          entityId: `users:${prefix}*`,
          after: { deletedCount: count },
        });
      }
    }
    totalDeleted += count;
  }

  const after = await prisma().user.count();
  console.log(`[cleanup-test-users] ${dryRun ? 'Would delete' : 'Deleted'} ${totalDeleted} test users. Remaining: ${after}`);
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  process.stderr.write(`[cleanup-test-users] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
