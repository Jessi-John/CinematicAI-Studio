/**
 * Local CI script that mirrors the GitHub Actions workflow.
 * Run this before pushing to verify the same gates that CI enforces.
 *
 * Mirrors:
 *   - backend: typecheck, typecheck:all, lint, build, audit --high, test
 *   - frontend: typecheck, typecheck:test, lint, test, audit --high, build
 *
 * Does NOT run E2E/integration tests (those need Docker services running).
 */

const { execSync } = require('child_process');

function run(label, cmd, cwd) {
  console.log(`\n=== ${label} ===`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit' });
  } catch {
    console.error(`FAILED: ${label}`);
    process.exit(1);
  }
}

// L2a: anchor to the script's location, not the caller's cwd — running from
// any other directory previously audited the wrong project.
const ROOT = require('path').resolve(__dirname, '..');
run('Frontend npm audit', 'npm audit --audit-level=high', ROOT);
run('Frontend typecheck', 'npx tsc --noEmit', ROOT);
run('Frontend typecheck tests', 'npx tsc -p tsconfig.test.json --noEmit', ROOT);
run('Frontend lint', 'npx eslint .', ROOT);
run('Frontend unit tests', 'npx vitest run', ROOT);
run('Frontend build', 'npm run build', ROOT);

const backendDir = require('path').join(ROOT, 'backend');
run('Backend npm audit', 'npm audit --audit-level=high', backendDir);
run('Backend typecheck', 'npx tsc --noEmit', backendDir);
run('Backend typecheck tests', 'npm run typecheck:all', backendDir);
run('Backend lint', 'npm run lint', backendDir);
run('Backend unit tests', 'npx vitest run', backendDir);
run('Backend build', 'npm run build', backendDir);
run('Build artifact freshness', 'node scripts/check-build-artifacts.js', process.cwd());

console.log('\n=== All local CI checks passed ===');
