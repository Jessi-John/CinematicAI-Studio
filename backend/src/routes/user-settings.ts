import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { storiesLimiter } from '../middleware/rate-limit.js';
import { logger } from '../services/logger.js';
import {
  getAllUserSettings,
  getUserSettingItem,
  setUserSetting,
  deleteUserSetting,
  batchSetUserSettings,
  USER_SETTING_KEYS,
  validateSettingValue,
} from '../services/user-settings.js';
import type { ApiResponse, UserSettingItem } from '../services/types.js';
import type { AuthenticatedRequest } from '../middleware/jwt.js';

const router = Router();

const settingTypeSchema = z.enum(['string', 'number', 'boolean', 'json']);

const upsertOneSchema = z.object({
  value: z.string(),
  type: settingTypeSchema,
});

const upsertBatchSchema = z.object({
  // L7: bound the batch — an unbounded array enabled long serial upsert
  // loops in one transaction.
  settings: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      type: settingTypeSchema,
    })
  ).max(100),
});

const keyParamSchema = z.string().min(1).max(100);

// All routes on this router are already protected by apiAuthMiddleware
// in server.ts (/api/user-settings). storiesLimiter is applied here too
// to keep consistent rate limiting with other user-data endpoints.

// GET /api/user-settings — return all user settings
router.get(
  '/',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;
    const all = await getAllUserSettings(userId);
    return res.json({ success: true, data: all } satisfies ApiResponse<UserSettingItem[]>);
  })
);

// GET /api/user-settings/:key — return single setting
router.get(
  '/:key',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!keyParamSchema.safeParse(key).success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key format',
      } satisfies ApiResponse<null>);
    }

    // For known keys, return typed default; for unknown keys, return empty string
    const knownKeys = Object.keys(USER_SETTING_KEYS) as string[];
    const isKnown = knownKeys.includes(key);
    const authReq = req as AuthenticatedRequest;
    const item = await getUserSettingItem(key, '', authReq.user?.sub);

    if (!isKnown && item.value === '') {
      return res.status(404).json({
        success: false,
        error: 'Setting not found',
      } satisfies ApiResponse<null>);
    }

    return res.json({
      success: true,
      data: item,
    } satisfies ApiResponse<UserSettingItem>);
  })
);

// PUT /api/user-settings/:key — upsert a single setting
router.put(
  '/:key',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!keyParamSchema.safeParse(key).success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key format',
      } satisfies ApiResponse<null>);
    }

    const validation = upsertOneSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected { value: string, type: "string" | "number" | "boolean" | "json" }',
      } satisfies ApiResponse<null>);
    }

    const { value, type } = validation.data;

    // Validate value parses correctly for the declared type
    if (!validateSettingValue(type, value)) {
      return res.status(400).json({
        success: false,
        error: `Value "${value}" cannot be parsed as type "${type}"`,
      } satisfies ApiResponse<null>);
    }

    try {
      const authReq = req as AuthenticatedRequest;
      const saved = await setUserSetting(key, value, type, authReq.user?.sub);
      return res.json({ success: true, data: saved } satisfies ApiResponse<UserSettingItem>);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ key, err: errMsg }, 'Failed to save user setting');
      return res.status(500).json({
        success: false,
        error: 'Failed to save setting',
      } satisfies ApiResponse<null>);
    }
  })
);

// PUT /api/user-settings — batch upsert multiple settings
router.put(
  '/',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const validation = upsertBatchSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected { settings: [{ key, value, type }] }',
      } satisfies ApiResponse<null>);
    }

    try {
      const authReq = req as AuthenticatedRequest;
      const results = await batchSetUserSettings(validation.data.settings, authReq.user?.sub);
      return res.json({ success: true, data: results } satisfies ApiResponse<UserSettingItem[]>);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'Batch update failed',
      } satisfies ApiResponse<null>);
    }
  })
);

// DELETE /api/user-settings/:key — delete a setting
router.delete(
  '/:key',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!keyParamSchema.safeParse(key).success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key format',
      } satisfies ApiResponse<null>);
    }

    const authReq = req as AuthenticatedRequest;
    await deleteUserSetting(key, authReq.user?.sub);
    return res.json({ success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: true }>);
  })
);

export const userSettingsRouter = router;