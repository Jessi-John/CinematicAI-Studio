/**
 * Build-artifact freshness check.
 *
 * If build artifacts are tracked in git, this script rebuilds the project and
 * verifies that the tracked files are identical to the freshly built output.
 * If no artifacts are tracked, the script succeeds but warns that artifacts
 * are ignored and must be produced by CI rather than committed.
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');

const args = process.argv.slice(2);
const backendOnly = args.includes('--backend-only');
const frontendOnly = args.includes('--frontend-only');

function run(label, cmd, cwd) {
  console.log(`\n=== ${label} ===`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit' });
  } catch (err) {
    console.error(`FAILED: ${label}`);
    process.exit(1);
  }
}

function git(args, cwd = ROOT) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function isGitRepo() {
  return git('rev-parse --git-dir') !== null;
}

function trackedFilesIn(dir) {
  const output = git(`ls-files ${dir}`);
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

function dirtyTrackedFiles() {
  const output = git('status --porcelain backend/dist .next/standalone');
  if (!output) return [];
  // L1a: filter to TRACKED-change codes only — `??` untracked entries inside
  // dist dirs were previously mislabeled as "tracked files changed" and the
  // error message then wrongly advised committing them.
  return output.split('\n').filter((l) => l.length > 1 && l[1] !== '?' && l[0] !== '?');
}

if (!isGitRepo()) {
  console.log('Not inside a git repository — cannot verify tracked build artifacts. Skipping.');
  process.exit(0);
}

const backendTracked = trackedFilesIn('backend/dist');
const frontendTracked = trackedFilesIn('.next/standalone');

if (backendTracked.length === 0 && frontendTracked.length === 0) {
  console.log('Build artifact directories are not tracked in git (they are likely gitignored).');
  console.log('CI must build them fresh on every run; do not commit generated artifacts.');
  process.exit(0);
}

console.log('Tracked build artifacts detected; rebuilding to verify freshness...');

if (backendTracked.length > 0 && !frontendOnly) {
  run('Backend build', 'npm run build', BACKEND_DIR);
}

if (frontendTracked.length > 0 && !backendOnly) {
  run('Frontend build', 'npm run build', ROOT);
}

const dirty = dirtyTrackedFiles();
if (dirty.length > 0) {
  console.error('\nBuild artifacts are stale. The following tracked files changed after rebuilding:');
  dirty.forEach((f) => console.error(`  ${f}`));
  console.error('\nRun `npm run build` in the root and backend, then commit the updated artifacts.');
  process.exit(1);
}

console.log('\nBuild artifacts are up to date.');
