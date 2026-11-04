import path from 'node:path';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { moduleDir } from '../lib/module-path.js';
import { loadWindowsSecrets } from './windows-secrets.js';

let loaded = false;

/**
 * Load environment files for both local and Docker entrypoints.
 *
 * Load order (each overrides the previous):
 *   1. Windows Credential Manager / DPAPI — OS-encrypted secret store
 *   2. .env files — local overrides for machine-specific config
 *
 * Local backend commands usually run from backend/, while Docker runs from
 * /app and mounts the repository .env there. Loading the parent/root .env
 * first lets local backend processes see the same secrets used by Compose;
 * backend/.env can still override or add machine-local values such as
 * DATABASE_URL for Prisma CLI usage.
 */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;

  // Step 1: Load OS-encrypted secrets (Windows DPAPI) — only on Windows,
  // silently no-ops on Linux/macOS. These provide the actual secret values
  // so .env can remain as __SET_ME_* placeholders.
  loadWindowsSecrets();

  // Step 2: Load .env files — found values override Credential Manager.
  // Resolve relative to this source file so running scripts from any cwd
  // (backend/, backend/src/config/, scripts/, etc.) finds the same repo files.
  const __dirname = moduleDir(import.meta.url);
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const backendRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.resolve(repoRoot, '.env'),
    path.resolve(backendRoot, '.env'),
  ];

  const seen = new Set<string>();
  // Track env vars set by .env files to distinguish them from env vars
  // set by docker-compose or the OS (which were in process.env before
  // loadEnvFiles ran). .env files can override each other (later overrides
  // earlier), but docker-compose/OS env vars ALWAYS take precedence.
  const setByDotEnv = new Set<string>();
  candidates.forEach((candidate, __index) => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    let content = '';
    try {
      content = readFileSync(candidate, 'utf8');
    } catch {
      return; // File not found — silently skip (matches dotenv.config behavior)
    }
    const parsed = dotenv.parse(content);
    for (const [key, value] of Object.entries(parsed)) {
      // If this var was set by a PREVIOUS .env file, override it
      // (later .env files take precedence over earlier ones).
      if (setByDotEnv.has(key)) {
        process.env[key] = value;
        continue;
      }
      // If already in process.env but NOT set by a .env file, it came
      // from docker-compose or the OS — NEVER override it. This prevents
      // the root .env from silently overriding docker-compose environment
      // blocks (e.g. ADMIN_API_KEY or STORY_TEST_MODE=canned for E2E).
      if (process.env[key] !== undefined) {
        continue;
      }
      // First time seeing this key — set it from the .env file.
      process.env[key] = value;
      setByDotEnv.add(key);
    }
  });
}