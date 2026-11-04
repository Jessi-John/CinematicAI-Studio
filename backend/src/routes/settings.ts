import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, asyncMiddleware } from '../middleware/error.js';
import { verifyAdminAuth } from '../middleware/admin.js';
import { prisma } from '../database/prisma.js';
import type { ApiResponse } from '../services/types.js';
import { logger } from '../services/logger.js';

// LOW-24: Default values returned when no settings exist in the database.
// M28: grade_floor defaults to 'C' to match quality_floor=70. Grade C is the
// floor for the numeric quality score 70 (per gradeFor(): >=70 → C). Setting
// grade_floor='B' here would be STRICTER than quality_floor=70 and would reject
// valid C-grade stories (real AI output typically scores 70-85).
const DEFAULT_SETTINGS: Record<string, SettingValue> = {
  quality_floor: 70,
  grade_floor: 'C',
  humanization_score_limit: 80,
  humanization_story_budget: 50,
  humanization_story_quality_retries: 2,
};

// Map of well-known pipeline settings stored in system_settings that should be
// readable and writable via the /api/settings endpoint. Previously the settings
// endpoint only read/wrote userSettings with userId='global', but the actual
// pipeline settings live in the system_settings table. This merge ensures both
// tables are read and written atomically.
const SYSTEM_SETTING_DEFAULTS: Record<string, { value: string; type: 'string' | 'number' | 'boolean' | 'json' }> = {
  quality_floor: { value: '70', type: 'number' },
  grade_floor: { value: 'C', type: 'string' },
  humanization_score_limit: { value: '80', type: 'number' },
  humanization_story_budget: { value: '50', type: 'number' },
  humanization_story_quality_retries: { value: '2', type: 'number' },
};

// Pipeline quality keys that must only be updated via the validated admin endpoint.
// The generic /api/settings endpoint does NOT validate per-key type/range constraints,
// so allowing pipeline keys here would let admins write invalid values (e.g. quality_floor=9999).
const PIPELINE_KEY_WHITELIST = new Set(Object.keys(SYSTEM_SETTING_DEFAULTS));

const router = Router();

type SettingType = 'string' | 'number' | 'boolean' | 'json';
type SettingValue = string | number | boolean | Record<string, unknown>;

const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.unknown()),
]);

const settingSchema = z.object({
  key: z.string().min(1).max(100),
  value: settingValueSchema,
  type: z.enum(['string', 'number', 'boolean', 'json']).default('string'),
});

const KEY_RE = /^[a-zA-Z0-9_-]{1,100}$/;

function deserialize(raw: string, type: SettingType): SettingValue {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return raw === 'true';
    case 'json':
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return raw;
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

function serialize(value: SettingValue, type: SettingType): string {
  switch (type) {
    case 'number':
      return String(Number(value));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Fix #6: A typed wrapper that only swallows the *expected* "table not migrated
 * yet" error. The previous `safeOp` returned the fallback on every error,
 * which silently hid real bugs (network blip, auth failure, schema drift).
 * Now anything that isn't the documented "table missing" sentinel re-throws,
 * so the global error handler returns a 500 and the operator sees the failure
 * in the logs instead of a phantom 200 with empty data.
 */
function isTableMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('does not exist') ||
    m.includes('P2022') ||
    m.includes('relation "user_settings" does not exist')
  );
}

async function safeOp<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isTableMissing(err)) {
      // Documented fallback: the migration has not run yet. Returning the
      // fallback keeps dev/test usable without throwing.
      return fallback;
    }
    // Real error — let the global handler surface it as 500.
    logger.error({ err }, 'Settings operation failed unexpectedly');
    throw err;
  }
}

// GET /api/settings
// M25: admin-gated like the writes — global/system settings (pipeline gates,
// and anything ops stores under userId='global') must not be readable by
// every authenticated user.
router.get(
  '/',
  asyncMiddleware(verifyAdminAuth),
  asyncHandler(async (_req, res) => {
    const [userRows, systemRows] = await Promise.all([
      safeOp(
        () => prisma().userSettings.findMany({ where: { userId: 'global' }, orderBy: { key: 'asc' } }),
        []
      ),
      safeOp(
        () => prisma().systemSettings.findMany({ orderBy: { key: 'asc' } }),
        []
      ),
    ]);

    // Start with defaults, then overlay system_settings (authoritative), then userSettings
    const out: Record<string, SettingValue> = { ...DEFAULT_SETTINGS };
    for (const r of systemRows) {
      const type = SYSTEM_SETTING_DEFAULTS[r.key]?.type ?? 'string';
      out[r.key] = deserialize(r.value, type as SettingType);
    }
    for (const r of userRows) {
      out[r.key] = deserialize(r.value, r.type as SettingType);
    }
    const response: ApiResponse<Record<string, SettingValue>> = { success: true, data: out };
    res.json(response);
  })
);

// GET /api/settings/:key
router.get(
  '/:key',
  asyncMiddleware(verifyAdminAuth),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ success: false, error: 'Invalid setting key' });
    }
    // Check userSettings first (user-overridable), then system_settings (pipeline defaults)
    const row = await safeOp(() => prisma().userSettings.findUnique({ where: { userId_key: { userId: 'global', key } } }), null);
    if (row) {
      return res.json({
        success: true,
        data: {
          key: row.key,
          value: deserialize(row.value, row.type as SettingType),
          type: row.type,
        },
      });
    }
    // Fallback to system_settings for pipeline settings not in userSettings
    const sysRow = await safeOp(() => prisma().systemSettings.findUnique({ where: { key } }), null);
    if (sysRow) {
      const type = SYSTEM_SETTING_DEFAULTS[key]?.type ?? 'string';
      return res.json({
        success: true,
        data: {
          key: sysRow.key,
          value: deserialize(sysRow.value, type as SettingType),
          type,
        },
      });
    }
    return res.status(404).json({ success: false, error: 'Setting not found' });
  })
);

// PATCH /api/settings/:key
router.patch(
  '/:key',
  asyncMiddleware(verifyAdminAuth),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ success: false, error: 'Invalid setting key' });
    }
    // Block pipeline quality keys — these must be updated via the validated
    // admin endpoint (/api/admin/settings/pipeline/:key) which enforces
    // per-key type/range constraints.
    if (PIPELINE_KEY_WHITELIST.has(key)) {
      return res.status(400).json({
        success: false,
        error: `Setting "${key}" is a pipeline quality gate. Use PUT /api/admin/settings/pipeline/${key} instead.`,
      });
    }
    const parsed = settingSchema.safeParse({
      key,
      value: req.body?.value,
      type: req.body?.type,
    });
    if (!parsed.success) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }

    const { value, type } = parsed.data;
    const serialized = serialize(value, type);

    const row = await safeOp(
      () =>
        prisma().userSettings.upsert({
          where: { userId_key: { userId: 'global', key } },
          update: { value: serialized, type },
          create: { key, value: serialized, type, userId: 'global' },
        }),
      null
    );

    if (!row) return res.status(503).json({ success: false, error: 'Settings unavailable' });

    return res.json({
      success: true,
      data: {
        key: row.key,
        value: deserialize(row.value, row.type as SettingType),
        type: row.type,
      },
    });
  })
);

// PATCH /api/settings (batch) — Fix #6: report per-item outcome so the caller
// knows which keys were accepted, rejected for shape, or rejected for unsafe keys.
router.patch(
  '/',
  asyncMiddleware(verifyAdminAuth),
  asyncHandler(async (req, res) => {
    const arr = (req.body as { settings?: unknown }).settings;
    if (!Array.isArray(arr)) {
      return res.status(400).json({ success: false, error: 'Settings must be an array' });
    }
    // L7: bound the batch — an unbounded array enabled long serial upsert
    // loops holding DB locks in one transaction.
    if (arr.length > 100) {
      return res.status(400).json({ success: false, error: 'Too many settings in one batch (max 100)' });
    }

    const applied: Array<{ key: string; type: SettingType }> = [];
    const rejected: Array<{ key?: string; reason: string }> = [];

    const updates: Array<{
      key: string;
      value: string;
      type: SettingType;
    }> = [];

    for (const item of arr) {
      if (!item || typeof item !== 'object') {
        rejected.push({ reason: 'item is not an object' });
        continue;
      }
      const parsed = settingSchema.safeParse(item);
      if (!parsed.success) {
        rejected.push({ reason: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      const { key, value, type } = parsed.data;
      if (!KEY_RE.test(key)) {
        rejected.push({ key, reason: 'invalid key format' });
        continue;
      }
      // Block pipeline quality keys in batch updates too
      if (PIPELINE_KEY_WHITELIST.has(key)) {
        rejected.push({ key, reason: `pipeline key must use PUT /api/admin/settings/pipeline/${key}` });
        continue;
      }
      const serialized = serialize(value, type);
      updates.push({ key, value: serialized, type });
    }

    try {
      await prisma().$transaction(async (tx) => {
        for (const update of updates) {
          await tx.userSettings.upsert({
            where: { userId_key: { userId: 'global', key: update.key } },
            update: { value: update.value, type: update.type },
            create: { key: update.key, value: update.value, type: update.type, userId: 'global' },
          });
        }
      });
      for (const update of updates) {
        applied.push({ key: update.key, type: update.type });
      }
    } catch (err) {
      logger.error({ err }, 'Settings batch transaction failed');
      for (const update of updates) {
        rejected.push({ key: update.key, reason: 'persistence failed' });
      }
    }

    return res.json({
      success: true,
      data: {
        updated: applied.length,
        applied,
        rejected,
        rejectedCount: rejected.length,
      },
    });
  })
);

// DELETE /api/settings/:key
router.delete(
  '/:key',
  asyncMiddleware(verifyAdminAuth),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ success: false, error: 'Invalid setting key' });
    }
    // M1: Block pipeline quality keys here too. PATCH (single + batch) already
    // refuses these keys and redirects to the validated admin endpoint, but the
    // DELETE handler did not — letting an admin delete a quality gate (e.g.
    // quality_floor) via the generic endpoint and silently drop the floor.
    if (PIPELINE_KEY_WHITELIST.has(key)) {
      return res.status(400).json({
        success: false,
        error: `Setting "${key}" is a pipeline quality gate and cannot be deleted via this endpoint. Use PUT /api/admin/settings/pipeline/${key} to change it.`,
      });
    }
    let deleted = false;
    try {
      await prisma().userSettings.delete({ where: { userId_key: { userId: 'global', key } } });
      deleted = true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        // P2025: record not found — check system_settings
      } else if (isTableMissing(err)) {
        return res.json({ success: true, data: { deleted: false, reason: 'table missing' } });
      } else {
        throw err;
      }
    }
    // Also try to delete from system_settings if it's a pipeline key
    if (key in SYSTEM_SETTING_DEFAULTS) {
      try {
        await prisma().systemSettings.delete({ where: { key } });
        deleted = true;
      } catch {
        // Ignore if not found in system_settings
      }
    }
    return res.json({ success: true, data: { deleted } });
  })
);

export const settingsRouter = router;
