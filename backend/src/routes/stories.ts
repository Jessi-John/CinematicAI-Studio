import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/error.js';
import { storiesLimiter } from '../middleware/rate-limit.js';
import {
  getAllStories,
  getStoryById,
  updateStory,
  deleteStory,
  updateSceneNarration,
  updateEpisodeMeta,
} from '../database/prisma-storage.js';
import { prisma } from '../database/prisma.js';
import { getEpisodesPerStory, getScenesPerEpisode } from '../lib/timing.js';
import {
  getSceneSimilarityMatrix,
  getSceneConfidenceScores,
  getRegenerationHistory,
  logStoryEdit,
} from '../services/generation-logger.js';
import type { ApiResponse, Story, Episode, Scene } from '../services/types.js';
import type { AuthenticatedRequest } from '../middleware/jwt.js';
import { verifyStoryOwnership } from '../middleware/story-ownership.js';
import { STORY_ID_REGEX } from '../lib/id-regex.js';
import { logger } from '../services/logger.js';
import { writeAuditLog } from '../services/audit-log.js';

const router = Router();

// UUID v4 or CUID format (Prisma cuid: starts with 'c', 24-25 chars).
const idRegex = STORY_ID_REGEX;

// Fix MED-26: Check for HTML tags beyond just `<` and `>` characters.
// HTML entities like `&lt;` and Unicode variants can bypass the old check.
const htmlTagRegex = /<[a-z][\s\S]*>/i;
const noHtml = (val: string) => !htmlTagRegex.test(val);

const updateStorySchema = z
  .object({
    title: z.string().min(1).max(200).refine(noHtml, 'HTML tags are not allowed').optional(),
    status: z.enum(['draft', 'generating', 'complete', 'failed']).optional(),
    theme: z.string().refine(noHtml, 'HTML tags are not allowed').optional(),
  })
  .strict();

const listStoriesSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  cursor: z.string().refine(
    (val) => val.length > 0,
    'Cursor must be a non-empty string'
  ).optional(),
  search: z.string().max(200).optional(),
  genre: z.string().max(50).optional(),
  sortBy: z.enum(['newest', 'oldest', 'title']).optional().default('newest'),
});

// Optional query params for similarity endpoint (episode filter)
const similarityQuerySchema = z.object({
  episodeNumber: z.coerce.number().int().min(1).max(10).optional(),
});

// Optional query params for confidence endpoint (episode filter)
const confidenceQuerySchema = z.object({
  episodeNumber: z.coerce.number().int().min(1).max(10).optional(),
});

// Optional query params for regeneration-history endpoint (pagination)
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

function ensureValidId(id: string, res: import('express').Response): boolean {
  if (idRegex.test(id)) return true;
  res.status(400).json({ success: false, error: 'Invalid story ID format' } satisfies ApiResponse<null>);
  return false;
}

// GET /api/stories
router.get(
  '/',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const validation = listStoriesSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pagination parameters',
      } satisfies ApiResponse<null>);
    }

    // Filter stories by the authenticated user (multi-user support)
    // M26: fail closed when the user is somehow absent — previously the
    // missing filter returned EVERY user's stories (the /export sibling
    // was already hardened for exactly this).
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' } satisfies ApiResponse<null>);
    }

    const result = await getAllStories({
      ...validation.data as Parameters<typeof getAllStories>[0],
      userId,
    });
    return res.json({ success: true, data: result } satisfies ApiResponse<typeof result>);
  })
);

// GET /api/stories/export — backup all stories as JSON
// Fix HIGH-2: This MUST be defined before GET /:id so Express
// matches the literal /export path before treating "export" as a
// wildcard story ID parameter.
// Fix MED-14: Filter by the authenticated user so export only dumps
// the current user's stories, not every story in the system.
router.get(
  '/export',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;
    // Fix HIGH-14: require an authenticated user. Without this guard, a route
    // misconfiguration or upstream middleware failure could expose every story
    // in the system. The filter below already scopes to userId, but we enforce
    // auth explicitly to fail closed.
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await getAllStories({ limit: 1000, userId });
    const backup = result.stories.map((story) => ({
      id: story.id,
      title: story.title,
      genre: story.genre,
      seed: story.seed,
      theme: story.theme,
      status: story.status,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
      qualityScore: story.metadata?.qualityScore,
      qualityGrade: story.metadata?.qualityGrade,
      episodes: (story.episodes ?? []).map((ep: Episode) => ({
        number: ep.number,
        title: ep.title,
        synopsis: ep.synopsis,
        hook: ep.hook,
        cliffhanger: ep.cliffhanger,
        duration: ep.duration,
        scenes: ep.scenes.map((sc: Scene) => ({
          number: sc.number,
          duration: sc.duration,
          narrationText: sc.narration.text,
          imagePrompt: sc.imagePrompt.content,
          videoPrompt: sc.videoPrompt.content,
        })),
      })),
    }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="cinematicai-backup.json"');
    return res.json({
      success: true,
      data: backup,
      total: backup.length,
      exportedAt: new Date().toISOString(),
    } as unknown as ApiResponse<typeof backup & { total: number }>);
  })
);

// GET /api/stories/:id
router.get(
  '/:id',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;

    const story = await getStoryById(id, undefined);
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;
    return res.json({ success: true, data: story } satisfies ApiResponse<Story>);
  })
);

// PATCH /api/stories/:id
router.patch(
  '/:id',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;

    const validation = updateStorySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
      } satisfies ApiResponse<null>);
    }

    // Capture old values for audit trail before updating.
    const old = await getStoryById(id, undefined);
    if (!old) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(old.userId!, authReq, res)) return;

    // Fix #28: enforce the story status state machine. The API is only permitted
    // to reset a failed story back to draft (failed→draft). All other transitions
    // (draft→generating, generating→complete, generating→failed, failed→generating)
    // are controlled by the worker pipeline.
    const newStatus = (validation.data as Partial<Story>).status;
    if (newStatus !== undefined && newStatus !== old.status) {
      // Only failed→draft is allowed via the API.
      if (old.status !== 'failed' || newStatus !== 'draft') {
        return res.status(409).json({
          success: false,
          error: `Invalid status transition '${old.status}' → '${newStatus}'. The API only permits resetting a failed story to draft.`,
        } satisfies ApiResponse<null>);
      }
    }

    const updated = await updateStory(id, validation.data as Partial<Story>);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }

    // Log each changed field as a separate audit entry.
    for (const field of Object.keys(validation.data) as Array<keyof typeof validation.data>) {
      const oldVal = old[field as keyof typeof old];
      const newVal = updated[field as keyof typeof updated];
      if (oldVal !== newVal) {
        await logStoryEdit({
          storyId: id,
          field: String(field),
          oldValue: String(oldVal ?? ''),
          newValue: String(newVal ?? ''),
        });
      }
    }

    const auditIp = req.ip;
    const auditUa = req.headers['user-agent'];
    const auditUserId = authReq.user?.sub;
    // CRIT-15: Wrap audit-log write in try/catch so a write failure
    // (e.g. DB timeout) does not return 500 after the mutation succeeded.
    await writeAuditLog({
      action: 'UPDATE',
      entityType: 'story',
      entityId: id,
      before: { status: old.status, title: old.title, theme: old.theme },
      after: { status: updated.status, title: updated.title, theme: updated.theme },
      ...(auditIp !== undefined ? { ipAddress: auditIp } : {}),
      ...(auditUa !== undefined ? { userAgent: auditUa } : {}),
      ...(auditUserId !== undefined ? { userId: auditUserId } : {}),
    }).catch((err) => {
      logger.warn({ err, entityId: id }, 'Audit-log write failed after UPDATE');
    });

    return res.json({ success: true, data: updated } satisfies ApiResponse<Story>);
  })
);

// DELETE /api/stories/:id
router.delete(
  '/:id',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;

    logger.info({ id }, 'Deleting story');
    const story = await prisma().story.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;
    const deleted = await deleteStory(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    const deleteAuditIp = req.ip;
    const deleteAuditUa = req.headers['user-agent'];
    const deleteAuditUserId = authReq.user?.sub;
    // CRIT-15: Wrap audit-log write in try/catch so a write failure
    // does not return 500 after the deletion succeeded.
    await writeAuditLog({
      action: 'DELETE',
      entityType: 'story',
      entityId: id,
      ...(deleteAuditIp !== undefined ? { ipAddress: deleteAuditIp } : {}),
      ...(deleteAuditUa !== undefined ? { userAgent: deleteAuditUa } : {}),
      ...(deleteAuditUserId !== undefined ? { userId: deleteAuditUserId } : {}),
    }).catch((err) => {
      logger.warn({ err, entityId: id }, 'Audit-log write failed after DELETE');
    });
    return res.json({ success: true, data: { deleted: true } } satisfies ApiResponse<{ deleted: true }>);
  })
);

// GET /api/stories/:id/similarity
// Fix #9: Thread the `episodeNumber` query param into the service so the
//   response is filtered to one episode's scene similarity matrix. The
//   previous version accepted the param (via Zod) but ignored it, so
//   every request returned the full corpus-wide matrix regardless of
//   the caller's intent.
// HIGH #12: Ownership check prevents IDOR — users can only read similarity
//   matrices for stories they own.
router.get(
  '/:id/similarity',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;
    const story = await prisma().story.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;

    const validation = similarityQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
      } satisfies ApiResponse<null>);
    }

    const data = await getSceneSimilarityMatrix(id, validation.data.episodeNumber);
    return res.json({ success: true, data });
  })
);

// GET /api/stories/:id/confidence
// Fix #9: Same — thread `episodeNumber` into the confidence service so a
//   caller asking "how confident are we in episode 4?" gets episode 4's
//   scores, not the whole story.
// HIGH #12: Ownership check prevents IDOR.
router.get(
  '/:id/confidence',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;
    const story = await prisma().story.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;

    const validation = confidenceQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
      } satisfies ApiResponse<null>);
    }

    const data = await getSceneConfidenceScores(id, validation.data.episodeNumber);
    return res.json({ success: true, data });
  })
);

// GET /api/stories/:id/regeneration-history
router.get(
  '/:id/regeneration-history',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!ensureValidId(id, res)) return;

    const authReq = req as AuthenticatedRequest;

    const story = await prisma().story.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
    }
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;

    const validation = historyQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
      } satisfies ApiResponse<null>);
    }

    const history = await getRegenerationHistory(id, validation.data.limit, validation.data.offset);
    return res.json({ success: true, data: { history } });
  })
);

/**
 * PATCH /api/stories/:id/episodes/:episodeNumber
 * Update episode metadata (title, hook, synopsis, cliffhanger).
 * User must own the story. Increments episode version.
 */
router.patch(
  '/:id/episodes/:episodeNumber',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.sub) {
      return res.status(401).json({ success: false, error: 'Unauthorized' } satisfies ApiResponse<null>);
    }
    const storyId = String(req.params.id);
    if (!ensureValidId(storyId, res)) return;

    const episodeNumber = parseInt(String(req.params.episodeNumber), 10);
    const maxEpisode = getEpisodesPerStory();
    if (Number.isNaN(episodeNumber) || episodeNumber < 1 || episodeNumber > maxEpisode) {
      return res.status(400).json({
        success: false,
        error: `Invalid episode number (1-${maxEpisode})`,
      } satisfies ApiResponse<null>);
    }

    const editSchema = z.object({
      title: z.string().min(1).max(200).refine(noHtml, 'HTML tags are not allowed').optional(),
      hook: z.string().max(500).refine(noHtml, 'HTML tags are not allowed').optional(),
      synopsis: z.string().max(1000).refine(noHtml, 'HTML tags are not allowed').optional(),
      cliffhanger: z.string().max(500).refine(noHtml, 'HTML tags are not allowed').optional(),
      expectedVersion: z.number().int().min(0),
    }).strict();

    const validation = editSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
      } satisfies ApiResponse<null>);
    }

    // Find the episode by storyId + episodeNumber
    const episode = await prisma().episode.findFirst({
      where: { storyId, number: episodeNumber },
      include: { story: { select: { userId: true } } },
    });

    if (!episode || !episode.story) {
      return res.status(404).json({ success: false, error: 'Episode not found' } satisfies ApiResponse<null>);
    }

    // L9: mirror verifyStoryOwnership — admins bypass the owner check here
    // as they do everywhere else.
    if (episode.story.userId !== authReq.user.sub && authReq.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' } satisfies ApiResponse<null>);
    }

    try {
      const cleanUpdates: Record<string, string> = {};
      for (const [key, value] of Object.entries(validation.data)) {
        if (key !== 'expectedVersion' && value !== undefined) {
          cleanUpdates[key] = value as string;
        }
      }
      await updateEpisodeMeta(episode.id, cleanUpdates as { title?: string; hook?: string; synopsis?: string; cliffhanger?: string }, validation.data.expectedVersion, authReq.user.sub);
      const episodeAuditIp = req.ip;
      const episodeAuditUa = req.headers['user-agent'];
      // CRIT-15: Wrap audit-log write in try/catch
      await writeAuditLog({
        action: 'UPDATE',
        entityType: 'episode',
        entityId: episode.id,
        after: cleanUpdates,
        ...(episodeAuditIp !== undefined ? { ipAddress: episodeAuditIp } : {}),
        ...(episodeAuditUa !== undefined ? { userAgent: episodeAuditUa } : {}),
        userId: authReq.user.sub,
      }).catch((err) => {
        logger.warn({ err, entityId: episode.id }, 'Audit-log write failed after episode UPDATE');
      });
      const story = await getStoryById(storyId);
      if (!story) {
        return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
      }
      return res.json({ success: true, data: story } satisfies ApiResponse<Story>);
    } catch (err) {
      // M24: log internal error server-side; return a static message.
      // Operational AppErrors (<500) still surface their message, but 5xx
      // responses never reflect internal details.
      if (err instanceof AppError) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.statusCode >= 500 ? 'Failed to update episode' : err.message,
          ...(err.code ? { code: err.code } : {}),
        } satisfies ApiResponse<null>);
      }
      logger.error({ err }, 'Failed to update episode');
      return res.status(500).json({ success: false, error: 'Failed to update episode' } satisfies ApiResponse<null>);
    }
  })
);

/**
 * PATCH /api/stories/:id/episodes/:episodeNumber/scenes/:sceneNumber
 * Update a scene's narration text. User must own the story.
 * Increments scene version and logs the edit.
 */
router.patch(
  '/:id/episodes/:episodeNumber/scenes/:sceneNumber',
  storiesLimiter,
  asyncHandler(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.sub) {
      return res.status(401).json({ success: false, error: 'Unauthorized' } satisfies ApiResponse<null>);
    }
    const storyId = String(req.params.id);
    if (!ensureValidId(storyId, res)) return;

    const episodeNumber = parseInt(String(req.params.episodeNumber), 10);
    const sceneNumber = parseInt(String(req.params.sceneNumber), 10);
    const maxEpisode = getEpisodesPerStory();
    const maxScene = getScenesPerEpisode();
    if (Number.isNaN(episodeNumber) || episodeNumber < 1 || episodeNumber > maxEpisode) {
      return res.status(400).json({ success: false, error: `Invalid episode number (1-${maxEpisode})` } satisfies ApiResponse<null>);
    }
    if (Number.isNaN(sceneNumber) || sceneNumber < 1 || sceneNumber > maxScene) {
      return res.status(400).json({ success: false, error: `Invalid scene number (1-${maxScene})` } satisfies ApiResponse<null>);
    }

    const sceneSchema = z.object({
      narrationText: z.string().min(10).max(2000),
      expectedVersion: z.number().int().min(0),
    }).strict();

    const validation = sceneSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
      } satisfies ApiResponse<null>);
    }

    // Find the scene by storyId + episodeNumber + sceneNumber
    // Fix: Use the top-level prisma import instead of a dynamic import().
    const scene = await prisma().scene.findFirst({
      where: {
        episode: { storyId, number: episodeNumber },
        number: sceneNumber,
      },
      include: {
        episode: {
          include: { story: { select: { userId: true } } },
        },
      },
    });

    if (!scene) {
      return res.status(404).json({ success: false, error: 'Scene not found' } satisfies ApiResponse<null>);
    }

    if (scene.episode.story.userId !== authReq.user.sub && authReq.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' } satisfies ApiResponse<null>);
    }

    try {
      await updateSceneNarration(scene.id, validation.data.narrationText, validation.data.expectedVersion, authReq.user.sub);
      const sceneAuditIp = req.ip;
      const sceneAuditUa = req.headers['user-agent'];
      // CRIT-15: Wrap audit-log write in try/catch
      await writeAuditLog({
        action: 'UPDATE',
        entityType: 'scene',
        entityId: scene.id,
        after: { narrationText: validation.data.narrationText },
        ...(sceneAuditIp !== undefined ? { ipAddress: sceneAuditIp } : {}),
        ...(sceneAuditUa !== undefined ? { userAgent: sceneAuditUa } : {}),
        userId: authReq.user.sub,
      }).catch((err) => {
        logger.warn({ err, entityId: scene.id }, 'Audit-log write failed after scene UPDATE');
      });
      const story = await getStoryById(storyId);
      if (!story) {
        return res.status(404).json({ success: false, error: 'Story not found' } satisfies ApiResponse<null>);
      }
      return res.json({ success: true, data: story } satisfies ApiResponse<Story>);
    } catch (err) {
      // M24: operational AppErrors (<500) surface their message, but 5xx
      // responses never reflect internal details.
      if (err instanceof AppError) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.statusCode >= 500 ? 'Failed to update scene' : err.message,
          ...(err.code ? { code: err.code } : {}),
        } satisfies ApiResponse<null>);
      }
      logger.error({ err }, 'Failed to update scene');
      return res.status(500).json({ success: false, error: 'Failed to update scene' } satisfies ApiResponse<null>);
    }
  })
);

export const storiesRouter = router;
