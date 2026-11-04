/**
 * User Settings Service
 *
 * Reads/writes user preferences from the UserSettings table. Values are
 * cached in-memory for 30 seconds per key. Concurrent requests for the same
 * uncached key are coalesced — only one DB query is issued and all waiters
 * share the same result (thundering-herd prevention).
 */

import { prisma } from '../database/prisma.js';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

// M13: Cache is now keyed by `${userId}:${key}` to scope settings per-user.
const MAX_CACHE_SIZE = 1000;
const cache = new Map<string, CacheEntry>();

function evictIfFull(): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

// In-flight requests — prevents thundering herd when cache misses.
const inflightRequests = new Map<string, Promise<string>>();

function cacheKey(userId: string | undefined, key: string): string {
  return `${userId ?? 'global'}:${key}`;
}

function isCacheHit(ck: string): boolean {
  const entry = cache.get(ck);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    cache.delete(ck);
    return false;
  }
  return true;
}

function setCache(ck: string, value: string): void {
  evictIfFull();
  cache.set(ck, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCache(ck: string): string | null {
  if (!isCacheHit(ck)) return null;
  const entry = cache.get(ck);
  return entry ? entry.value : null;
}

function invalidateCache(ck: string): void {
  cache.delete(ck);
}

function _invalidateAllCache(): void {
  cache.clear();
}

/** Typed setting value returned by the API. */
export interface UserSettingItem {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  updatedAt: string;
}

/** Supported setting keys and their types. */
export const USER_SETTING_KEYS = {
  preferred_genre: 'string',
  auto_save_generations: 'boolean',
} as const;

export type UserSettingKey = keyof typeof USER_SETTING_KEYS;

/** Validate that a value parses correctly for its declared type. */
export function validateSettingValue(type: string, value: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      // M33: Number('') === 0 and Number('Infinity') is not NaN — both
      // previously passed validation. Require a finite, non-empty number.
      return value.trim() !== '' && Number.isFinite(Number(value));
    case 'boolean':
      return value === 'true' || value === 'false';
    case 'json':
      try { JSON.parse(value); return true; } catch { return false; }
    default:
      return false;
  }
}

/**
 * Get a user setting by key. Returns defaultValue if not found.
 * M13: Now scoped by userId — each user has their own settings.
 */
export async function getUserSetting(
  key: string,
  defaultValue: string,
  userId?: string
): Promise<string> {
  const ck = cacheKey(userId, key);
  const cached = getCache(ck);
  if (cached !== null) return cached;

  const existing = inflightRequests.get(ck);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // M13: Query by composite unique key (userId, key)
      const row = await prisma().userSettings.findUnique({
        where: { userId_key: { userId: userId ?? 'global', key } },
        select: { value: true },
      });
      const value = row?.value ?? defaultValue;
      setCache(ck, value);
      return value;
    } finally {
      inflightRequests.delete(ck);
    }
  })();

  inflightRequests.set(ck, promise);
  return promise;
}

/**
 * Get a boolean user setting. Returns defaultValue if not found or
 * the stored value cannot be parsed as a boolean.
 */
export async function getUserSettingBoolean(
  key: string,
  defaultValue: boolean,
  userId?: string
): Promise<boolean> {
  const stored = await getUserSetting(key, String(defaultValue), userId);
  // M33: honor the documented fallback — a stored garbage value ('yes', '1')
  // previously returned false even when defaultValue was true.
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return defaultValue;
}

/**
 * Get a user setting by key including its updatedAt timestamp.
 * Returns the default value and current timestamp if not found.
 */
export async function getUserSettingItem(
  key: string,
  defaultValue: string,
  userId?: string
): Promise<UserSettingItem> {
  const ck = cacheKey(userId, key);
  const cachedValue = getCache(ck);

  const row = await prisma().userSettings.findUnique({
    where: { userId_key: { userId: userId ?? 'global', key } },
    select: { value: true, type: true, updatedAt: true },
  });

  if (row) {
    setCache(ck, row.value);
    return {
      key,
      value: row.value,
      type: row.type as UserSettingItem['type'],
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  if (cachedValue !== null) {
    return {
      key,
      value: cachedValue,
      type: 'string',
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    key,
    value: defaultValue,
    type: 'string',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Upsert a user setting. Creates if not exists, updates if exists.
 * M13: Now scoped by userId.
 * Type is validated before writing. Throws on invalid type or value.
 */
export async function setUserSetting(
  key: string,
  value: string,
  type: 'string' | 'number' | 'boolean' | 'json',
  userId?: string
): Promise<UserSettingItem> {
  if (!validateSettingValue(type, value)) {
    throw new Error(`Invalid value for type ${type}`);
  }

  const updated = await prisma().userSettings.upsert({
    where: { userId_key: { userId: userId ?? 'global', key } },
    create: { key, value, type, userId: userId ?? 'global' },
    update: { value, type },
    select: { key: true, value: true, type: true, updatedAt: true },
  });

  // Update cache with the new value
  setCache(cacheKey(userId, key), value);

  return {
    key: updated.key,
    value: updated.value,
    type: updated.type as UserSettingItem['type'],
    updatedAt: updated.updatedAt.toISOString(),
  };
}

/**
 * Delete a user setting by key. M13: Now scoped by userId.
 */
export async function deleteUserSetting(key: string, userId?: string): Promise<void> {
  await prisma().userSettings.deleteMany({ where: { key, userId: userId ?? 'global' } });
  invalidateCache(cacheKey(userId, key));
}

/**
 * Get all user settings. Returns an empty array if none exist.
 * M13: Now scoped by userId.
 */
export async function getAllUserSettings(userId?: string): Promise<UserSettingItem[]> {
  const rows = await prisma().userSettings.findMany({
    where: { userId: userId ?? 'global' },
    orderBy: { key: 'asc' },
    select: { key: true, value: true, type: true, updatedAt: true },
  });
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    type: r.type as UserSettingItem['type'],
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Batch upsert multiple user settings at once.
 * M13: Now scoped by userId.
 */
export async function batchSetUserSettings(
  settings: Array<{ key: string; value: string; type: 'string' | 'number' | 'boolean' | 'json' }>,
  userId?: string
): Promise<UserSettingItem[]> {
  for (const s of settings) {
    if (!validateSettingValue(s.type, s.value)) {
      throw new Error(`Invalid value for type ${s.type} on key ${s.key}`);
    }
  }

  // Use a transaction for atomicity
  await prisma().$transaction(
    settings.map((s) =>
      prisma().userSettings.upsert({
        where: { userId_key: { userId: userId ?? 'global', key: s.key } },
        create: { key: s.key, value: s.value, type: s.type, userId: userId ?? 'global' },
        update: { value: s.value, type: s.type },
        select: { key: true, value: true, type: true, updatedAt: true },
      })
    )
  );

  // Refresh cache for all updated keys
  for (const s of settings) {
    setCache(cacheKey(userId, s.key), s.value);
  }

  return getAllUserSettings(userId);
}