/**
 * Synchronises the root package.json version to backend/package.json AND
 * backend/package-lock.json after standard-version bumps the root version.
 *
 * Usage: node scripts/sync-version.mjs
 *
 * This script reads the new version from the root package.json
 * (which standard-version just bumped) and writes it into
 * backend/package.json and both version fields of backend/package-lock.json.
 * All three must stay in lockstep for the monorepo release strategy.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const backendPkgPath = join(ROOT, 'backend', 'package.json');
const backendPkg = JSON.parse(readFileSync(backendPkgPath, 'utf-8'));

const newVersion = rootPkg.version;
if (backendPkg.version !== newVersion) {
  backendPkg.version = newVersion;
  writeFileSync(backendPkgPath, JSON.stringify(backendPkg, null, 2) + '\n');
  console.log(`Synced backend version to ${newVersion}`);
} else {
  console.log(`Backend version already ${newVersion} — no sync needed`);
}

// M68: the backend lockfile carries its own version fields (top-level and
// packages[""]) — previously left stale on every release.
const backendLockPath = join(ROOT, 'backend', 'package-lock.json');
try {
  const backendLock = JSON.parse(readFileSync(backendLockPath, 'utf-8'));
  let changed = false;
  if (backendLock.version !== newVersion) {
    backendLock.version = newVersion;
    changed = true;
  }
  if (backendLock.packages?.[''] && backendLock.packages[''].version !== newVersion) {
    backendLock.packages[''].version = newVersion;
    changed = true;
  }
  if (changed) {
    writeFileSync(backendLockPath, JSON.stringify(backendLock, null, 2) + '\n');
    console.log(`Synced backend package-lock.json version to ${newVersion}`);
  }
} catch {
  console.warn('backend/package-lock.json not found or unreadable — skipped lockfile sync');
}
