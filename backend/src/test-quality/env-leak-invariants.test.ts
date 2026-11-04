/**
 * Invariant: security-critical env vars (STORY_TEST_MODE, E2E_TEST) must
 * NEVER use `${VAR:-}` shell substitution in docker-compose.yml, which
 * leaked shell env vars into containers and bypassed auth rate limiters.
 *
 * Root cause: both vars used `${VAR:-}` in the `environment:` section.
 * When a script or operator had the var set, it leaked into every
 * `docker compose up` call — even after the script finished.
 *
 * The fix: security-critical env vars are hardcoded in
 * docker-compose.e2e.yml (the override file) and NOT referenced with
 * shell substitution in docker-compose.yml.
 *
 * This test:
 *   1) Ensures ${STORY_TEST_MODE and ${E2E_TEST are NEVER in
 *      docker-compose.yml (catches re-introduction of the leak)
 *   2) Ensures docker-compose.e2e.yml EXISTS (the override mechanism
 *      that replaced the shell-substitution pattern)
 *   3) Ensures docker-compose.e2e.yml contains the expected overrides
 *      for both vars
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

describe('env-leak-invariants', () => {
  // process.cwd() in vitest = the package root (where vitest.config.ts is).
  // For backend/ this is D:\youtube\backend\. docker-compose.yml is one
  // level up. Using process.cwd() instead of __dirname because vitest's
  // __dirname resolution can vary between environments (node vs jsdom).
  const REPO_ROOT = resolve(process.cwd(), '..');
  const SRC_ROOT = resolve(process.cwd(), 'src');

  it('docker-compose.yml must NOT contain ${STORY_TEST_MODE or ${E2E_TEST}', () => {
    const composePath = resolve(REPO_ROOT, 'docker-compose.yml');
    const content = readFileSync(composePath, 'utf-8');
    expect(content).not.toContain('${STORY_TEST_MODE');
    expect(content).not.toContain('${E2E_TEST');
  });

  it('docker-compose.yml must NOT contain ALLOW_E2E_IN_PRODUCTION', () => {
    // The production opt-in for the E2E bypass must NEVER be present in the
    // base compose file — only in the e2e override. Its presence here would
    // silently re-enable the auth/CSRF/rate-limit bypass in normal operation.
    const composePath = resolve(REPO_ROOT, 'docker-compose.yml');
    const content = readFileSync(composePath, 'utf-8');
    expect(content).not.toContain('ALLOW_E2E_IN_PRODUCTION');
  });

  it('docker-compose.e2e.yml must exist (override file for E2E vars)', () => {
    const e2ePath = resolve(REPO_ROOT, 'docker-compose.e2e.yml');
    expect(existsSync(e2ePath)).toBe(true);
  });

  it('docker-compose.e2e.yml must set STORY_TEST_MODE=canned and E2E_TEST=true', () => {
    const e2ePath = resolve(REPO_ROOT, 'docker-compose.e2e.yml');
    const content = readFileSync(e2ePath, 'utf-8');
    expect(content).toContain('STORY_TEST_MODE: canned');
    expect(content).toContain('E2E_TEST: "true"');
  });

  it('docker-compose.e2e.yml must set ALLOW_E2E_IN_PRODUCTION=true (base compose runs NODE_ENV=production)', () => {
    // The base docker-compose.yml runs backend/worker with NODE_ENV=production.
    // Every E2E/canned bypass is now gated on NODE_ENV !== production, so the
    // e2e override MUST opt in explicitly or the whole E2E suite runs with the
    // bypasses disabled and fails.
    const e2ePath = resolve(REPO_ROOT, 'docker-compose.e2e.yml');
    const content = readFileSync(e2ePath, 'utf-8');
    expect(content).toContain('ALLOW_E2E_IN_PRODUCTION: "true"');
  });

  it('e2eTestBypassEnabled and cannedModeEnabled are gated on non-production', () => {
    // Pin the central guard: both helpers must consult isProduction() and the
    // explicit ALLOW_E2E_IN_PRODUCTION override so a leaked test var cannot
    // disable security in production.
    const envSrc = readFileSync(resolve(SRC_ROOT, 'config/env.ts'), 'utf-8');
    expect(envSrc).toMatch(/export function e2eTestBypassEnabled/);
    expect(envSrc).toMatch(/export function cannedModeEnabled/);
    // Each helper body must reference the production gate + explicit override.
    const e2eBody = envSrc.match(/export function e2eTestBypassEnabled[\s\S]*?\n}/)?.[0] ?? '';
    const cannedBody = envSrc.match(/export function cannedModeEnabled[\s\S]*?\n}/)?.[0] ?? '';
    for (const body of [e2eBody, cannedBody]) {
      expect(body).toContain('ALLOW_E2E_IN_PRODUCTION');
      expect(body).toMatch(/isProduction\(\)/);
    }
  });

  it('no source file bypasses the central E2E/canned guards with raw env equality', () => {
    // Every E2E_TEST / STORY_TEST_MODE bypass must route through
    // e2eTestBypassEnabled()/cannedModeEnabled(). Forbid the raw equality
    // patterns anywhere in src outside the helper definitions and tests, so a
    // future change cannot re-introduce an ungated bypass.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry.startsWith('.')) continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        if (full.endsWith(join('config', 'env.ts'))) continue; // the helper definitions
        const content = readFileSync(full, 'utf-8');
        if (content.includes("process.env.E2E_TEST === 'true'")) offenders.push(`${full}: E2E_TEST`);
        if (content.includes("process.env.STORY_TEST_MODE === 'canned'")) offenders.push(`${full}: STORY_TEST_MODE`);
      }
    };
    walk(SRC_ROOT);
    expect(offenders).toEqual([]);
  });
});
