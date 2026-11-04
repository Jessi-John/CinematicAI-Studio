/**
 * Settings Service
 *
 * Reads system-wide pipeline thresholds from the database. Values are
 * seeded via migration so they can only be changed via a migration, not
 * accidentally in code.
 *
 * All reads are cached in-memory for 60 seconds to avoid DB spam.
 * Concurrent requests for the same uncached key are coalesced — only one
 * DB query is issued and all waiters share the same result.
 */

import { prisma as prismaInstance } from '../database/prisma.js';
import { logger } from './logger.js';

// prismaInstance is now a function () => PrismaClient. Call it to get the client.
let _prisma: ReturnType<typeof prismaInstance> | null = null;
function getPrisma(): ReturnType<typeof prismaInstance> {
  if (!_prisma) _prisma = prismaInstance();
  return _prisma;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 100;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function evictIfFull(): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

// In-flight requests — prevents thundering herd when cache misses.
// Only one DB query is issued per key; all concurrent waiters share the result.
const inflightRequests = new Map<string, Promise<string>>();

function isCacheHit(key: string): boolean {
  const entry = cache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return false;
  }
  return true;
}

function setCache(key: string, value: string): void {
  evictIfFull();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCache(key: string): string | null {
  if (!isCacheHit(key)) return null;
  return cache.get(key)!.value;
}

/**
 * Get a string setting. Returns defaultValue if the key is not found.
 * Concurrent cache-miss requests for the same key are coalesced — the first
 * request does the DB query, all others wait for the same promise.
 */
export async function getSystemSetting(
  key: string,
  defaultValue: string
): Promise<string> {
  const cached = getCache(key);
  if (cached !== null) return cached;

  // If another request is already fetching this key, share its promise.
  const existing = inflightRequests.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const row = await getPrisma().systemSettings.findUnique({
        where: { key },
        select: { value: true },
      });
      const value = row?.value ?? defaultValue;
      setCache(key, value);
      return value;
    } catch (err) {
      // M12: If the DB is unreachable (connection error), return the default
      // value instead of crashing the caller. Previously the catch was missing
      // — a transient DB outage would crash the pipeline (e.g., loadTimingOverrides
      // → getSystemSetting → unhandled rejection).
      logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, 'getSystemSetting DB error — returning default');
      return defaultValue;
    } finally {
      // Always clean up so a subsequent request (after TTL expiry) hits the DB again.
      inflightRequests.delete(key);
    }
  })();

  inflightRequests.set(key, promise);
  return promise;
}

/**
 * M34: Per-key allowlist with min/max bounds for numeric system settings.
 * Values like `episodes_per_story = 0` or negatives previously passed
 * validation and silently corrupted pipeline behavior (a live incident
 * where episodes_per_story was left at 2 went completely unnoticed).
 */
const NUMERIC_SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  episodes_per_story: { min: 1, max: 20 },
  scenes_per_episode: { min: 1, max: 10 },
  target_words_per_scene: { min: 5, max: 200 },
  target_words_per_episode_min: { min: 20, max: 1000 },
  target_words_per_episode_max: { min: 20, max: 2000 },
  scene_duration_min_seconds: { min: 1, max: 60 },
  scene_duration_max_seconds: { min: 1, max: 120 },
  speaking_wpm: { min: 50, max: 400 },
  target_episode_seconds: { min: 10, max: 300 },
  quality_floor: { min: 0, max: 100 },
  humanization_score_limit: { min: 0, max: 100 },
  humanization_story_budget: { min: 0, max: 1000 },
  humanization_story_quality_retries: { min: 0, max: 10 },
  seed_quality_threshold: { min: 0, max: 100 },
  publish_threshold: { min: 0, max: 100 },
};

const ALLOWED_SETTING_KEYS = new Set([
  ...Object.keys(NUMERIC_SETTING_BOUNDS),
  'grade_floor',
]);

function validateSettingKeyAndValue(key: string, value: string): void {
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    throw Object.assign(new Error(`Unknown system setting key: ${key}`), { statusCode: 400 });
  }
  const bounds = NUMERIC_SETTING_BOUNDS[key];
  if (bounds !== undefined) {
    // M34: parseInt('5abc') === 5 and parseInt('-3') === -3 previously passed.
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw Object.assign(new Error(`Setting ${key} must be an integer`), { statusCode: 400 });
    }
    if (n < bounds.min || n > bounds.max) {
      throw Object.assign(
        new Error(`Setting ${key} must be between ${bounds.min} and ${bounds.max} (got ${n})`),
        { statusCode: 400 }
      );
    }
  }
}

/**
 * Get an integer setting. Returns defaultValue if the key is not found or
 * the stored value cannot be parsed as an integer.
 */
export async function getSystemSettingInt(
  key: string,
  defaultValue: number
): Promise<number> {
  const stored = await getSystemSetting(key, String(defaultValue));
  const n = Number(stored);
  return Number.isFinite(n) && value_is_int(stored) ? n : defaultValue;
}

function value_is_int(s: string): boolean {
  return /^-?\d+$/.test(s.trim());
}

/**
 * Set a system setting in the database. Updates the in-memory cache so the
 * new value is immediately visible without a TTL wait.
 */
export async function setSystemSetting(key: string, value: string): Promise<void> {
  validateSettingKeyAndValue(key, value);
  await getPrisma().systemSettings.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  // Invalidate and refresh cache so next read gets the new value
  cache.delete(key);
  setCache(key, value);
}

/**
 * Set multiple system settings atomically inside a single transaction.
 * Either all updates persist or none do, preventing partial timing/quality
 * configuration states.
 */
export async function batchSetSystemSettings(
  entries: Array<{ key: string; value: string }>
): Promise<void> {
  for (const { key, value } of entries) {
    validateSettingKeyAndValue(key, value);
  }
  await getPrisma().$transaction(async (tx) => {
    for (const { key, value } of entries) {
      await tx.systemSettings.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  });
  for (const { key, value } of entries) {
    cache.delete(key);
    setCache(key, value);
  }
}