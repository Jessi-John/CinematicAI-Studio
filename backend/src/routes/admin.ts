import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { verifyAdminAuth } from '../middleware/admin.js';
import { asyncMiddleware } from '../middleware/error.js';
import { logger } from '../services/logger.js';
import { storyQueue, storyDlq, getBackgroundDlq, type DlqEntry, type BackgroundDlqEntry, type StoryJobData } from '../queue/index.js';
import { batchSetSystemSettings, getSystemSettingInt, setSystemSetting, getSystemSetting } from '../services/settings.js';
import {
  SPEAKING_WPM,
  TARGET_EPISODE_SECONDS,
  TARGET_WORDS_PER_EPISODE_MIN,
  TARGET_WORDS_PER_EPISODE_MAX,
  SCENES_PER_EPISODE,
  EPISODES_PER_STORY,
  TARGET_WORDS_PER_SCENE,
  SCENE_DURATION_MIN_SECONDS,
  SCENE_DURATION_MAX_SECONDS,
} from '../lib/timing.js';
import type { ApiResponse } from '../services/types.js';
import { STORY_ID_REGEX } from '../lib/id-regex.js';
import { prisma } from '../database/prisma.js';

// Fix #47: Zod schemas for admin route parameters. These were previously
// parsed by hand (`String(req.params.jobId)`), which silently accepts
// anything. The schemas add length and character-set constraints so a
// malformed jobId (e.g. with a `?` or `&` injected) is rejected before
// it reaches the BullMQ layer.
//
// jobId format: must be either a UUID v4 (8-4-4-4-12 hex) or a BullMQ
// internal id (starts with `c` followed by 20-28 lowercase alphanumeric
// characters). This matches the previous hand-rolled regex exactly so
// existing test contracts (admin-extended.test.ts, routes-extended.test.ts)
// continue to pass.
//
// L1: Tightened regex — CUIDs (BullMQ job IDs) are always lowercase base36.
// Previously the `i` flag made the CUID part case-insensitive, accepting
// uppercase strings that can never be valid CUIDs. UUID hex is explicitly
// [0-9a-fA-F] to accept both cases (some external systems emit uppercase).
export const jobIdParamSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    STORY_ID_REGEX,
    'jobId must be a UUID or BullMQ job id (c + 20-28 lowercase alphanumeric)'
  );

// Field names match the keys the client sends in PATCH /api/admin/settings/timing
// (see lib/timing.ts and the verify-fixes.sh test cases). The cross-field refines
// add the relationship validation the previous hand-written loop was missing.
//
// Exported for openapi.ts (Fix #26) to generate OpenAPI spec from Zod schemas.
export const timingUpdateSchema = z
  .object({
    episodesPerStory: z.number().int().min(1).max(20).optional(),
    scenesPerEpisode: z.number().int().min(1).max(20).optional(),
    targetWordsPerScene: z.number().int().min(5).max(100).optional(),
    targetEpisodeWordsMin: z.number().int().min(50).max(500).optional(),
    targetEpisodeWordsMax: z.number().int().min(50).max(500).optional(),
    sceneDurationMinSeconds: z.number().int().min(1).max(60).optional(),
    sceneDurationMaxSeconds: z.number().int().min(1).max(60).optional(),
    speakingWpm: z.number().int().min(50).max(300).optional(),
    targetEpisodeSeconds: z.number().int().min(10).max(300).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.targetEpisodeWordsMin === undefined ||
      data.targetEpisodeWordsMax === undefined ||
      data.targetEpisodeWordsMin <= data.targetEpisodeWordsMax,
    {
      message: 'targetEpisodeWordsMin must be <= targetEpisodeWordsMax',
      path: ['targetEpisodeWordsMin'],
    }
  )
  .refine(
    (data) =>
      data.sceneDurationMinSeconds === undefined ||
      data.sceneDurationMaxSeconds === undefined ||
      data.sceneDurationMinSeconds <= data.sceneDurationMaxSeconds,
    {
      message: 'sceneDurationMinSeconds must be <= sceneDurationMaxSeconds',
      path: ['sceneDurationMinSeconds'],
    }
  );

// Pipeline values are stored as strings in system_settings. Numbers are
// accepted at the API boundary for operator convenience and coerced by
// validatePipelineValue. Booleans are intentionally NOT accepted: they
// would round-trip to 'true'/'false' with no semantic meaning for the
// existing grade_floor / quality_floor / humanization_* keys.
// Exported for openapi.ts (Fix #26).
export const pipelineUpdateSchema = z
  .object({
    value: z.union([z.string(), z.number()]),
  })
  .strict();

function parseJobId(raw: string): string | null {
  const parsed = jobIdParamSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const router = Router();

// Apply admin auth to all routes on this router
router.use(asyncMiddleware(verifyAdminAuth));

// Admin limiter: 60/min for queue operations
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { success: false, error: 'Admin API rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(adminLimiter);

// GET /api/admin/queue — queue depth and DLQ status
async function getCompletedTodayCount(queue: typeof storyQueue): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();
  // BullMQ returns completed jobs newest first. M23: page in chunks and stop
  // once we pass the start of today — the previous `getJobs(['completed'],
  // 0, -1)` loaded the ENTIRE completed history into memory on every request
  // while the comment claimed the opposite.
  const PAGE = 500;
  let count = 0;
  try {
    for (let start = 0; ; start += PAGE) {
      const page = (await queue.getJobs(['completed'], start, start + PAGE - 1)) ?? [];
      if (!Array.isArray(page) || page.length === 0) break;
      let reachedBeforeToday = false;
      for (const job of page) {
        const finishedOn = (job as { finishedOn?: number | null }).finishedOn;
        if (typeof finishedOn === 'number') {
          if (finishedOn >= cutoff) count++;
          else reachedBeforeToday = true;
        }
      }
      if (reachedBeforeToday || page.length < PAGE) break;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to enumerate completed jobs for daily count');
    return 0;
  }
  return count;
}

router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const [queueDepth, activeJobs, completedToday, dlqWaiting] = await Promise.all([
      storyQueue.getWaitingCount(),
      storyQueue.getActiveCount(),
      getCompletedTodayCount(storyQueue),
      __storyDlq.getWaitingCount(),
    ]);

    // Get recent DLQ entries (up to 20 failed/waiting jobs)
    // DLQ jobs are added via queue.add() which puts them in 'waiting' state,
    // not 'failed' — so we read from the waiting list.
    const dlqJobs = await __storyDlq.getJobs(['waiting'], 0, 19);
    const recentFailures: Array<{
      jobId: string;
      genre: string[];
      failedAt: number;
      failedReason: string;
      attemptsMade: number;
    }> = dlqJobs.map((job) => {
      const data = job.data as DlqEntry;
      return {
        jobId: data.jobId,
        genre: data.genre,
        failedAt: data._failedAt,
        failedReason: data._failedReason,
        attemptsMade: job.attemptsMade,
      };
    });

    return res.json({
      success: true,
      data: {
        queueDepth,
        activeJobs,
        completedToday,
        // FIX: DLQ jobs are added via queue.add() → waiting state, not
        // addDlq() → failed state. Reading waiting count gives real depth.
        dlqDepth: dlqWaiting,
        recentFailures,
      },
    } satisfies ApiResponse<{
      queueDepth: number;
      activeJobs: number;
      completedToday: number;
      dlqDepth: number;
      recentFailures: Array<{
        jobId: string;
        genre: string[];
        failedAt: number;
        failedReason: string;
        attemptsMade: number;
      }>;
    }>);
  })
);

// POST /api/admin/queue/:jobId/restart — restart a DLQ job
/**
 * C2 FIX: Build the job payload for re-enqueueing a DLQ entry back onto the
 * main story-generation queue. The original job's userId/webhookUrl/storyId
 * MUST be preserved — dropping userId previously sent the pipeline down the
 * `userId ?? 'unknown'` path, which violates the stories.userId RESTRICT
 * foreign key and re-failed the job into the DLQ forever (death loop). DLQ
 * metadata (_failedReason/_failedAt) is stripped; retryFromDlq is set so the
 * pipeline relaxes the quality floor for the retry.
 */
function buildDlqRetryJobData(data: DlqEntry): StoryJobData {
  return {
    jobId: data.jobId,
    genre: data.genre,
    ...(data.seed !== undefined ? { seed: data.seed } : {}),
    ...(data.forceNew !== undefined ? { forceNew: data.forceNew } : {}),
    ...(data.requestId !== undefined ? { requestId: data.requestId } : {}),
    ...(data.userId !== undefined ? { userId: data.userId } : {}),
    ...(data.webhookUrl !== undefined ? { webhookUrl: data.webhookUrl } : {}),
    ...(data.storyId !== undefined ? { storyId: data.storyId } : {}),
    addedAt: Date.now(),
    retryFromDlq: true,
  };
}

// The DLQ has no consuming worker, so entries sit in the 'waiting' state (plus
// 'delayed' for any delayed re-adds). Read all non-terminal states so the list
// is not permanently empty; 'failed' is included for forward-compat if a DLQ
// worker is ever introduced.
const DLQ_READ_STATES: Array<'waiting' | 'delayed' | 'prioritized' | 'failed'> = ['waiting', 'delayed', 'prioritized', 'failed'];

router.post(
  '/queue/:jobId/restart',
  asyncHandler(async (req, res) => {
    const jobId = parseJobId(String(req.params.jobId));
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid job ID format',
      } satisfies ApiResponse<null>);
    }

    // Search DLQ for the job by jobId or BullMQ internal job id.
// Attempt targeted lookup first before falling back to a full scan.
    let dlqJob = await __storyDlq.getJob(jobId);
    if (!dlqJob) {
      // Try with dlq- prefix
      dlqJob = await __storyDlq.getJob(`dlq-${jobId}`);
    }
    // Final fallback: scan DLQ entries (linear, bounded at 200). The DLQ has
    // no consuming worker, so entries are 'waiting' — not 'failed'.
    if (!dlqJob) {
      const dlqJobs = await __storyDlq.getJobs(DLQ_READ_STATES, 0, 199);
      dlqJob = dlqJobs.find(
        (j) => (j.data as DlqEntry).jobId === jobId || j.id === jobId || j.id === `dlq-${jobId}`
      ) ?? undefined;
    }

    if (!dlqJob) {
      return res.status(404).json({
        success: false,
        error: 'DLQ entry not found for this job ID',
      } satisfies ApiResponse<null>);
    }

    const data = dlqJob.data as DlqEntry;

    // Re-add to the main queue. C2 FIX: preserve userId/webhookUrl/storyId and
    // strip DLQ metadata via buildDlqRetryJobData — dropping userId previously
    // caused an unrecoverable death loop (RESTRICT user FK violation).
    // M28: retryFromDlq=true so the pipeline accepts the story regardless of
    // quality floor; a story in the DLQ was already generated once and would
    // otherwise just be pushed back to the DLQ.
    const newJob = await __storyQueue.add(
      'generate',
      buildDlqRetryJobData(data),
      {
        jobId: data.jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 100 },
      }
    );

    // CRIT-16: Remove the DLQ entry after successful re-enqueue.
    // Without this, the stale DLQ entry persists and accumulates —
    // restarting the same job multiple times creates duplicate DLQ entries
    // that never get cleaned up.
    await dlqJob.remove().catch((err) => {
      logger.warn({ err, jobId: data.jobId }, 'Failed to remove DLQ entry after restart');
    });

    return res.json({
      success: true,
      data: {
        restarted: true,
        originalJobId: jobId,
        newJobId: newJob.id ?? jobId,
      },
    } satisfies ApiResponse<{
      restarted: boolean;
      originalJobId: string;
      newJobId: string;
    }>);
  })
);

// GET /api/admin/settings — return current timing/pipeline constants
router.get(
  '/settings/timing',
  asyncHandler(async (req, res) => {
    const [
      episodesPerStory,
      scenesPerEpisode,
      targetWordsPerScene,
      targetEpisodeWordsMin,
      targetEpisodeWordsMax,
      sceneDurationMin,
      sceneDurationMax,
      speakingWpm,
      targetEpisodeSeconds,
    ] = await Promise.all([
      getSystemSettingInt('episodes_per_story', EPISODES_PER_STORY),
      getSystemSettingInt('scenes_per_episode', SCENES_PER_EPISODE),
      getSystemSettingInt('target_words_per_scene', TARGET_WORDS_PER_SCENE),
      getSystemSettingInt('target_words_per_episode_min', TARGET_WORDS_PER_EPISODE_MIN),
      getSystemSettingInt('target_words_per_episode_max', TARGET_WORDS_PER_EPISODE_MAX),
      getSystemSettingInt('scene_duration_min_seconds', SCENE_DURATION_MIN_SECONDS),
      getSystemSettingInt('scene_duration_max_seconds', SCENE_DURATION_MAX_SECONDS),
      getSystemSettingInt('speaking_wpm', SPEAKING_WPM),
      getSystemSettingInt('target_episode_seconds', TARGET_EPISODE_SECONDS),
    ]);
    return res.json({
      success: true,
      data: {
        episodesPerStory,
        scenesPerEpisode,
        targetWordsPerScene,
        targetEpisodeWordsMin,
        targetEpisodeWordsMax,
        sceneDurationMinSeconds: sceneDurationMin,
        sceneDurationMaxSeconds: sceneDurationMax,
        speakingWpm,
        targetEpisodeSeconds,
      },
    } satisfies ApiResponse<{
      episodesPerStory: number;
      scenesPerEpisode: number;
      targetWordsPerScene: number;
      targetEpisodeWordsMin: number;
      targetEpisodeWordsMax: number;
      sceneDurationMinSeconds: number;
      sceneDurationMaxSeconds: number;
      speakingWpm: number;
      targetEpisodeSeconds: number;
    }>);
  })
);

// PATCH /api/admin/settings/timing — update timing constants
router.patch(
  '/settings/timing',
  asyncHandler(async (req, res) => {
    // Fix #47: replace the 9 hand-rolled `Number(...)` + bounds checks with a
    // single Zod pass. The schema's `.strict()` rejects unknown fields, the
    // cross-field refines add the min<=max relationship check the previous
    // loop was missing (and that the test at admin-extended.test.ts:484
    // noted was absent), and all type/range rules live in one place.
    const parsed = timingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return res.status(400).json({
        success: false,
        error: `Invalid timing update — ${detail}`,
      } satisfies ApiResponse<null>);
    }

    const d = parsed.data;
    const updates: Array<{ key: string; value: number }> = [];

    if (d.episodesPerStory !== undefined) updates.push({ key: 'episodes_per_story', value: d.episodesPerStory });
    if (d.scenesPerEpisode !== undefined) updates.push({ key: 'scenes_per_episode', value: d.scenesPerEpisode });
    if (d.targetWordsPerScene !== undefined) updates.push({ key: 'target_words_per_scene', value: d.targetWordsPerScene });
    if (d.targetEpisodeWordsMin !== undefined) updates.push({ key: 'target_words_per_episode_min', value: d.targetEpisodeWordsMin });
    if (d.targetEpisodeWordsMax !== undefined) updates.push({ key: 'target_words_per_episode_max', value: d.targetEpisodeWordsMax });
    if (d.sceneDurationMinSeconds !== undefined) updates.push({ key: 'scene_duration_min_seconds', value: d.sceneDurationMinSeconds });
    if (d.sceneDurationMaxSeconds !== undefined) updates.push({ key: 'scene_duration_max_seconds', value: d.sceneDurationMaxSeconds });
    if (d.speakingWpm !== undefined) updates.push({ key: 'speaking_wpm', value: d.speakingWpm });
    if (d.targetEpisodeSeconds !== undefined) updates.push({ key: 'target_episode_seconds', value: d.targetEpisodeSeconds });

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid timing fields provided',
      } satisfies ApiResponse<null>);
    }

    // Apply all timing changes atomically so the pipeline never runs with a
    // partially applied configuration.
    try {
      await batchSetSystemSettings(updates.map((u) => ({ key: u.key, value: String(u.value) })));
    } catch (err) {
      logger.error({ err, updates }, 'Admin timing update transaction failed');
      return res.status(503).json({
        success: false,
        error: 'Failed to persist timing settings',
      } satisfies ApiResponse<null>);
    }

    // L2 — Audit log for admin timing changes
    logger.info(
      { action: 'admin_timing_update', updates, admin: req.user?.sub ?? 'unknown' },
      'Admin timing settings updated'
    );

    return res.json({
      success: true,
      data: { updated: updates },
    } satisfies ApiResponse<{ updated: Array<{ key: string; value: number }> }>);
  })
);

// Whitelist of pipeline-quality keys that can be updated via the API.
// These are the settings the worker reads from system_settings to gate
// generation (story.worker.ts:100-104). Without this endpoint, an operator
// would have to run raw SQL to change quality_floor or grade_floor — which
// is the gap that produced the silent test-only workaround in the E2E report.
const PIPELINE_KEY_TYPES: Record<string, 'int' | 'grade'> = {
  quality_floor: 'int',
  grade_floor: 'grade',
  humanization_score_limit: 'int',
  humanization_story_budget: 'int',
  humanization_story_quality_retries: 'int',
};
const VALID_GRADES = new Set(['A', 'B', 'C', 'D', 'F']);

function validatePipelineValue(
  key: string,
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const kind = PIPELINE_KEY_TYPES[key];
  if (!kind) {
    return { ok: false, error: `Unknown pipeline setting "${key}"` };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, error: `Value for "${key}" must be a string or number` };
  }
  const str = String(raw);
  if (kind === 'int') {
    if (!/^\d+$/.test(str)) {
      return { ok: false, error: `Value for "${key}" must be a non-negative integer` };
    }
    const n = Number(str);
    if (key === 'quality_floor' || key === 'humanization_score_limit') {
      if (n < 0 || n > 100) {
        return { ok: false, error: `Value for "${key}" must be 0-100` };
      }
    } else if (key === 'humanization_story_budget') {
      if (n < 0 || n > 1000) {
        return { ok: false, error: `Value for "${key}" must be 0-1000` };
      }
    } else if (key === 'humanization_story_quality_retries') {
      if (n < 0 || n > 10) {
        return { ok: false, error: `Value for "${key}" must be 0-10` };
      }
    }
    return { ok: true, value: str };
  }
  // 'grade'
  const upper = str.toUpperCase();
  if (!VALID_GRADES.has(upper)) {
    return { ok: false, error: `Value for "${key}" must be one of A, B, C, D, F` };
  }
  return { ok: true, value: upper };
}

// GET /api/admin/settings/pipeline — read the worker's quality-gate settings.
router.get(
  '/settings/pipeline',
  asyncHandler(async (_req, res) => {
    const [qualityFloor, gradeFloor, humanizationLimit, humanizationBudget, humanizationRetries] =
      await Promise.all([
        getSystemSettingInt('quality_floor', 70),
        getSystemSetting('grade_floor', 'C'),
        getSystemSettingInt('humanization_score_limit', 80),
        getSystemSettingInt('humanization_story_budget', 50),
        getSystemSettingInt('humanization_story_quality_retries', 2),
      ]);
    return res.json({
      success: true,
      data: {
        qualityFloor,
        gradeFloor,
        humanizationLimit,
        humanizationBudget,
        humanizationRetries,
      },
    } satisfies ApiResponse<{
      qualityFloor: number;
      gradeFloor: string;
      humanizationLimit: number;
      humanizationBudget: number;
      humanizationRetries: number;
    }>);
  })
);

// PUT /api/admin/settings/pipeline/:key — update a single pipeline setting.
// Body: { "value": <string|number> }. Whitelist of keys is enforced below;
// per-key type/range constraints are enforced in validatePipelineValue.
// Fix #47: the body shape itself is now validated by Zod so a typo'd field
// name or wrong type fails with a precise error instead of silently
// coercing via String() inside validatePipelineValue.
router.put(
  '/settings/pipeline/:key',
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    if (!(key in PIPELINE_KEY_TYPES)) {
      return res.status(400).json({
        success: false,
        error: `Unknown pipeline setting "${key}". Allowed: ${Object.keys(PIPELINE_KEY_TYPES).join(', ')}`,
      } satisfies ApiResponse<null>);
    }
    const parsed = pipelineUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return res.status(400).json({
        success: false,
        error: `Invalid pipeline update — ${detail}`,
      } satisfies ApiResponse<null>);
    }
    const result = validatePipelineValue(key, parsed.data.value);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error } satisfies ApiResponse<null>);
    }
    await setSystemSetting(key, result.value);

    // L2 — Audit log for admin pipeline changes
    logger.info(
      { action: 'admin_pipeline_update', key, value: result.value, admin: req.user?.sub ?? 'unknown' },
      'Admin pipeline setting updated'
    );

    return res.json({
      success: true,
      data: { key, value: result.value },
    } satisfies ApiResponse<{ key: string; value: string }>);
  })
);

// GET /api/admin/dlq — all dead letter entries (story DLQ + background DLQ)
router.get(
  '/dlq',
  asyncHandler(async (_req, res) => {
    const [dlqJobs, backgroundDlqJobs] = await Promise.all([
      __storyDlq.getJobs(DLQ_READ_STATES, 0, 499),
      getBackgroundDlq().getJobs(DLQ_READ_STATES, 0, 499),
    ]);
    const entries: Array<{
      jobId: string;
      genre: string[];
      failedAt: number;
      failedReason: string;
      attemptsMade: number;
      data: DlqEntry;
    }> = dlqJobs.map((job) => {
      const data = job.data as DlqEntry;
      return {
        jobId: data.jobId,
        genre: data.genre,
        failedAt: data._failedAt,
        failedReason: data._failedReason,
        attemptsMade: job.attemptsMade,
        data,
      };
    });
    // Fix #29: surface background-job failures alongside the main
    // pipeline DLQ. The shape differs (BackgroundDlqEntry vs DlqEntry)
    // so we tag each entry with a `source` field for the admin UI.
    const backgroundEntries: Array<{
      source: 'background';
      jobId: string;
      failedAt: string;
      failedReason: string;
      data: BackgroundDlqEntry;
    }> = backgroundDlqJobs.map((job) => {
      const data = job.data as BackgroundDlqEntry;
      return {
        source: 'background' as const,
        jobId: data.jobId,
        failedAt: data.failedAt,
        failedReason: data.reason,
        data,
      };
    });
    return res.json({
      success: true,
      data: { entries, backgroundEntries },
    } satisfies ApiResponse<{
      entries: Array<{
        jobId: string;
        genre: string[];
        failedAt: number;
        failedReason: string;
        attemptsMade: number;
        data: DlqEntry;
      }>;
      backgroundEntries: Array<{
        source: 'background';
        jobId: string;
        failedAt: string;
        failedReason: string;
        data: BackgroundDlqEntry;
      }>;
    }>);
  })
);

// POST /api/admin/dlq/:jobId/requeue — requeue a job from DLQ
router.post(
  '/dlq/:jobId/requeue',
  asyncHandler(async (req, res) => {
    const jobId = parseJobId(String(req.params.jobId));
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid job ID format',
      } satisfies ApiResponse<null>);
    }

    let dlqJob = await __storyDlq.getJob(jobId);
    if (!dlqJob) {
      dlqJob = await __storyDlq.getJob(`dlq-${jobId}`);
    }
    if (!dlqJob) {
      const dlqJobs = await __storyDlq.getJobs(DLQ_READ_STATES, 0, 199);
      dlqJob = dlqJobs.find(
        (j) => (j.data as DlqEntry).jobId === jobId || j.id === jobId || j.id === `dlq-${jobId}`
      );
    }
    if (!dlqJob) {
      return res.status(404).json({
        success: false,
        error: 'Job not found in DLQ',
      } satisfies ApiResponse<null>);
    }

    const jobData = dlqJob.data as DlqEntry;
    // Fix: remove by the actual BullMQ job ID (dlqJob.id), not the user-supplied
    // jobId parameter. The user-supplied jobId is the story's logical ID, not the
    // BullMQ queue entry ID (which may be prefixed like "dlq-{storyId}").
    await __storyDlq.remove(dlqJob.id!);
    // C2 FIX: preserve userId/webhookUrl/storyId and strip DLQ metadata so the
    // requeued job does not death-loop on the RESTRICT user FK. Give it the
    // same retry policy as the restart endpoint.
    await __storyQueue.add('generate', buildDlqRetryJobData(jobData), {
      jobId: jobData.jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86400, count: 100 },
    });

    // L2 — Audit log for DLQ requeue
    logger.info(
      { action: 'admin_dlq_requeue', jobId: jobData.jobId, originalDlqId: jobId, admin: req.user?.sub ?? 'unknown' },
      'Admin requeued DLQ job'
    );

    return res.json({
      success: true,
      data: { jobId: jobData.jobId },
    } satisfies ApiResponse<{ jobId: string }>);
  })
);

// DELETE /api/admin/dlq/:jobId — delete a DLQ entry
router.delete(
  '/dlq/:jobId',
  asyncHandler(async (req, res) => {
    const jobId = parseJobId(String(req.params.jobId));
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid job ID format',
      } satisfies ApiResponse<null>);
    }

    let dlqJob = await __storyDlq.getJob(jobId);
    if (!dlqJob) {
      dlqJob = await __storyDlq.getJob(`dlq-${jobId}`);
    }
    if (!dlqJob) {
      const dlqJobs = await __storyDlq.getJobs(DLQ_READ_STATES, 0, 199);
      dlqJob = dlqJobs.find(
        (j) => (j.data as DlqEntry).jobId === jobId || j.id === jobId || j.id === `dlq-${jobId}`
      );
    }
    if (!dlqJob) {
      return res.status(404).json({
        success: false,
        error: 'Job not found in DLQ',
      } satisfies ApiResponse<null>);
    }

    await __storyDlq.remove(dlqJob.id!);

    return res.json({
      success: true,
      data: { jobId },
    } satisfies ApiResponse<{ jobId: string }>);
  })
);

// GET /api/admin/stats — system-wide statistics
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    // Fix: Use the top-level prisma import instead of a dynamic import().
    // No need to re-import prisma on every admin stats request — it's a lazy
    // getter function that's already loaded and cached at module level.
    const [totalStories, totalEpisodes, totalScenes, totalCharacters] = await Promise.all([
      prisma().story.count(),
      prisma().episode.count(),
      prisma().scene.count(),
      prisma().character.count(),
    ]);
    return res.json({
      success: true,
      data: { totalStories, totalEpisodes, totalScenes, totalCharacters },
    } satisfies ApiResponse<{
      totalStories: number;
      totalEpisodes: number;
      totalScenes: number;
      totalCharacters: number;
    }>);
  })
);

// POST /api/admin/cleanup-test-users — delete test users created by E2E tests
// Fix MED-1: Accumulated test users (e2e_*, testuser_*, stories_test_*) bloat the
// users table and slow auth queries. This endpoint provides a remote cleanup
// mechanism so E2E afterAll hooks can clean up without direct DB access.
// Fix MED-15: Rate limit cleanup to 3 requests per minute per IP — deleteMany
// on the full users table is expensive and could be abused as a DoS vector.
const cleanupLimiter = rateLimit({
  windowMs: 60_000,
  max: 3,
  message: { success: false, error: 'Too many cleanup requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.post(
  '/cleanup-test-users',
  cleanupLimiter,
  asyncHandler(async (_req, res) => {
    // Fix: Use the top-level prisma import. Same rationale as /stats above.
    const testPrefixes = ['e2e_', 'testuser_', 'stories_test_'];
    const results: Array<{ prefix: string; deleted: number }> = [];

    for (const prefix of testPrefixes) {
      const result = await prisma().user.deleteMany({
        where: { username: { startsWith: prefix } },
      });
      results.push({ prefix, deleted: result.count });
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
    logger.info({ totalDeleted, results }, 'Test user cleanup completed');
    return res.json({
      success: true,
      data: { totalDeleted, results },
    } satisfies ApiResponse<{ totalDeleted: number; results: Array<{ prefix: string; deleted: number }> }>);
  })
);

// ADMIN-004: Test injection point — allows tests to swap storyDlq with a controlled mock.
// Without this, vi.mock hoisting captures the original mock at module load time and
// per-test mockResolvedValueOnce calls have no effect on the already-captured reference.
let __storyDlq: typeof storyDlq = storyDlq;
export function __setStoryDlq(dlq: typeof storyDlq): void {
  __storyDlq = dlq;
}

// C2: Same injection point for storyQueue so tests can assert the exact job
// payload re-enqueued by the restart/requeue handlers (e.g. userId preserved).
let __storyQueue: typeof storyQueue = storyQueue;
export function __setStoryQueue(q: typeof storyQueue): void {
  __storyQueue = q;
}

export const adminRouter = router;