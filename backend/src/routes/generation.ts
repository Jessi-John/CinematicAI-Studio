import { Router, type Request } from 'express';
import { z } from 'zod';
import { randomUUID, createHmac } from 'node:crypto';
import { asyncHandler, AppError } from '../middleware/error.js';
import { getApiSecret, getMaxConcurrentGenerations, getMaxStoriesPerDay } from '../config/env.js';
import { aiLimiter } from '../middleware/rate-limit.js';
import { prisma } from '../database/prisma.js';
import { addStoryJob, storyQueue } from '../queue/index.js';
import { getEpisodesPerStory, getScenesPerEpisode } from '../lib/timing.js';
import { getGenerationStatus } from '../services/generation-logger.js';
import { logger } from '../services/logger.js';
import { checkText } from '../lib/copyright-filter.js';
import { jobsTotal } from '../routes/metrics.js';
import { findDuplicateConcept, SEMANTIC_DUP_THRESHOLD, LEXICAL_HARD_BLOCK } from '../services/similarity.js';
import { sleep } from '../lib/sleep.js';
import { getSharedRedis } from '../lib/shared-redis.js';
import { GENRE_LIST } from '../services/generation-helpers.js';
import { isUrlBlocked } from '../services/webhook.js';
import { regenerateEpisode } from '../services/episode-regeneration.js';
import { regenerateScene } from '../services/scene-regeneration.js';
import { regenerateStory, getRegenerationTimeoutMs } from '../services/story-regeneration.js';
import type { AuthenticatedRequest } from '../middleware/jwt.js';
import { STORY_ID_REGEX } from '../lib/id-regex.js';
import { getPublicBaseUrl } from '../lib/request-url.js';

const router = Router();

function appErrorResponse(err: AppError, fallback: string) {
  // M24: do not reflect internal/5xx messages to the client; keep the status
  // code (so the client can retry/distinguish) but use a static string for
  // anything that represents a server-side failure.
  return {
    status: err.statusCode,
    body: {
      success: false,
      error: err.statusCode >= 500 ? fallback : err.message,
      ...(err.code ? { code: err.code } : {}),
    },
  };
}

// UUID v4 or CUID format — must match stories.ts:idRegex.
const idRegex = STORY_ID_REGEX;

function ensureValidStoryId(id: string, res: import('express').Response): boolean {
  if (idRegex.test(id)) return true;
  res.status(400).json({ success: false, error: 'Invalid story ID format' });
  return false;
}

const generateSchema = z.object({
    genre: z
        .array(z.string())
        .min(1)
        .max(1, 'Select exactly one genre')
        .refine((g) => g.every((x) => GENRE_LIST.includes(x as typeof GENRE_LIST[number])), {
            message: 'Invalid genre provided',
        }),
    seed: z.string().max(500).optional(),
    forceNew: z.boolean().optional().default(false),
    webhookUrl: z.string().url().optional().refine(async (url) => {
        if (!url) return true;
        const result = await isUrlBlocked(url);
        return !result.blocked;
    }, { message: 'Webhook URL cannot point to internal or loopback networks' }),
});

function buildSSEUrl(jobId: string, req: Request) {
    const t = Date.now();
    const sig = createHmac('sha256', getApiSecret())
        .update(`${jobId}:${t}`)
        .digest('hex');
    // HIGH #26: Use the public base URL (respecting x-forwarded-* headers from
    // the BFF) so clients receive an externally reachable sseUrl instead of the
    // internal backend host.
    const baseUrl = getPublicBaseUrl(req);
    return {
        sseUrl: `${baseUrl}/api/stories/generate/${jobId}/events?auth=${sig}&t=${t}`,
        sseAuth: { auth: sig, t },
    };
}

// Production hardening: enforce global daily story quota and concurrent
// generation limits for single-user / small deployments.
async function checkGenerationQuota(userId: string | undefined): Promise<{ ok: boolean; reason?: string }> {
    const maxConcurrent = getMaxConcurrentGenerations();
    const maxPerDay = getMaxStoriesPerDay();

    if (maxConcurrent > 0) {
        const states = await storyQueue.getJobCounts('waiting', 'active', 'delayed');
        const active = (states.waiting || 0) + (states.active || 0) + (states.delayed || 0);
        if (active >= maxConcurrent) {
            return { ok: false, reason: `Too many concurrent generations (limit: ${maxConcurrent})` };
        }
    }

    if (maxPerDay > 0) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const count = await prisma().story.count({
            where: {
                createdAt: { gte: since },
                ...(userId ? { userId } : {}),
            },
        });
        if (count >= maxPerDay) {
            return { ok: false, reason: `Daily story limit reached (limit: ${maxPerDay})` };
        }
    }

    return { ok: true };
}

const IDEMPOTENCY_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_TTL_SECONDS = 86_400;

router.post('/', aiLimiter, asyncHandler(async (req, res) => {
    const idempotencyKey = req.headers['x-idempotency-key'];
    let requestId: string;
    if (typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
        requestId = idempotencyKey;
        const redis = getSharedRedis();
        // Atomic lock via SET NX: only the first request to acquire the lock
        // proceeds to duplicate check and enqueue. Subsequent requests with
        // the same key either wait for the cached response or get the lock.
        const lockKey = `idempotency:lock:${idempotencyKey}`;
        const lockAcquired = await redis.set(lockKey, '1', 'EX', 10, 'NX');
        if (!lockAcquired) {
            // Another request is processing this idempotency key.
            // Poll for the cached result up to 5 seconds.
            for (let i = 0; i < 50; i++) {
                const cached = await redis.get(`idempotency:${idempotencyKey}`);
                if (cached) {
                    try {
                        const parsed = JSON.parse(cached);
                        logger.debug({ idempotencyKey }, 'Idempotent replay (waited) — returning cached response');
                        return res.status(202).json(parsed);
                    } catch { /* retry */ }
                }
                await sleep(100);
            }
            return res.status(409).json({
                success: false,
                error: 'Concurrent request with same idempotency key is still processing',
            });
        }
        // Check cache (lock acquired — no race possible)
        try {
            const cached = await redis.get(`idempotency:${idempotencyKey}`);
            if (cached) {
                await redis.del(lockKey);
                try {
                    const parsed = JSON.parse(cached);
                    logger.debug({ idempotencyKey }, 'Idempotent replay — returning cached response');
                    return res.status(202).json(parsed);
                } catch { /* treat as cache miss */ }
            }
        } catch { /* ignore cache read errors, proceed */ }
    } else {
        requestId = randomUUID();
    }

    const validation = await generateSchema.safeParseAsync(req.body);
    if (!validation.success) {
        return res.status(400).json({
            success: false,
            error: 'Invalid request',
            message: validation.error.issues.map((issue) => issue.message).join('; ') || 'The request body was invalid. Please check your genre and seed values.',
        });
    }

    const { genre, seed, forceNew, webhookUrl } = validation.data;
    const primaryGenre = genre[0]!;

    // Pass userId from the authenticated user so the story is owned by them
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;

    if (seed) {
        const cr = checkText(seed);
        if (!cr.clean) {
            return res.status(400).json({
                success: false,
                error: 'Copyright-protected term in seed',
                message: `Your seed contains terms tied to existing IP: ${cr.hits.join(', ')}. Please rephrase.`,
            });
        }
    }

    logger.info({ genre: primaryGenre, seed: seed || null, jobId: requestId }, 'Enqueuing story generation');

    if (!forceNew) {
        const dup = await findDuplicateConcept(
            {
                genre: primaryGenre,
                ...(seed !== undefined ? { seed } : {}),
                theme: seed || '',
                title: seed || 'temp',
                ...(userId !== undefined ? { userId } : {}),
            },
            requestId
        );
        if (dup && (dup.score >= LEXICAL_HARD_BLOCK || (dup.via === 'semantic' && dup.score >= SEMANTIC_DUP_THRESHOLD))) {
            return res.status(409).json({
                success: false,
                error: 'Duplicate story concept detected',
                message: `This concept is too similar to "${dup.title}" (${dup.via} match, score ${dup.score.toFixed(2)}). Change the seed or pass forceNew=true.`,
                data: {
                    duplicateStoryId: dup.id,
                    duplicateTitle: dup.title,
                    similarityScore: dup.score,
                    via: dup.via,
                },
            });
        }
    }

    // Enforce single-user / small-deployment quotas before enqueueing.
    const quota = await checkGenerationQuota(userId);
    if (!quota.ok) {
        jobsTotal.inc({ status: 'rejected' });
        return res.status(429).json({ success: false, error: quota.reason });
    }

    const job = await addStoryJob({
        genre: [primaryGenre], // API expects array (string[])
        ...(seed !== undefined ? { seed } : {}),
        forceNew,
        requestId,
        ...(webhookUrl !== undefined ? { webhookUrl } : {}),
        ...(userId !== undefined ? { userId } : {}),
    });

    logger.info({ jobId: job.id }, 'Story generation job enqueued');

    const { sseUrl, sseAuth } = buildSSEUrl(job.id ?? requestId, req);
    const responseBody = {
        success: true,
        data: {
            jobId: job.id ?? requestId,
            requestId,
            sseUrl,
            sseAuth,
        },
        message: `Generation queued. Poll /api/stories/generate/${job.id ?? requestId}/events for progress.`,
    };

    if (idempotencyKey) {
        const redis = getSharedRedis();
        const lockKey = `idempotency:lock:${idempotencyKey}`;
        try {
            // We hold the distributed lock from the initial handshake, so no
            // race is possible here. Write the response and release the lock.
            await redis.set(`idempotency:${idempotencyKey}`, JSON.stringify(responseBody), 'EX', IDEMPOTENCY_TTL_SECONDS);
            await redis.del(lockKey);
        } catch (err) {
            logger.warn({ err, idempotencyKey }, 'Failed to cache idempotency response');
            // Best-effort: release the lock even if cache write failed
            try { await redis.del(lockKey); } catch { /* ignore */ }
        }
    }

    res.status(202).json(responseBody);
}));

router.get('/:storyId/generation-status', asyncHandler(async (req, res) => {
    const storyId = String(req.params.storyId);
    if (!ensureValidStoryId(storyId, res)) return;

    const authReq = req as AuthenticatedRequest;
    const ownershipError = await checkStoryOwnership(storyId, authReq.user?.sub);
    if (ownershipError) {
        const status = ownershipError === 'Forbidden' ? 403 : ownershipError === 'Unauthorized' ? 401 : 404;
        return res.status(status).json({ success: false, error: ownershipError });
    }

    const story = await prisma().story.findUnique({
        where: { id: storyId },
        include: {
            characters: true,
            episodes: {
                include: { scenes: { orderBy: { number: 'asc' } } },
                orderBy: { number: 'asc' },
            },
            environments: true,
            youtubeSeo: true,
            generationLogs: { orderBy: { createdAt: 'asc' } },
        },
    });
    if (!story) {
        return res.status(404).json({
            success: false,
            error: 'Story not found',
            message: `No story found with ID ${storyId}`,
        });
    }
    const status = await getGenerationStatus(storyId);
    res.status(200).json({
        success: true,
        data: {
            ...status,
            totalLogs: story.generationLogs.length,
            storyTitle: story.title,
            status: story.status,
        },
    });
}));

router.get('/:jobId/full-state', asyncHandler(async (req, res) => {
    const jobId = String(req.params.jobId);
    if (!ensureValidStoryId(jobId, res)) return;
    const job = await storyQueue.getJob(jobId);
    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Job not found',
        });
    }

    // Ownership verification:
    // - In-progress jobs do not have a persisted story yet, so we check
    //   job.data.userId (set at enqueue time) against the authenticated user.
    // - Completed jobs have job.data.storyId; we prefer verifying against the
    //   persisted story row (which has the canonical userId) for backward
    //   compatibility with jobs that were created before userId was stored.
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;
    const jobUserId = job.data?.userId as string | undefined;
    const storyId = job.data?.storyId as string | undefined;

    if (jobUserId) {
        if (jobUserId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
    } else if (storyId) {
        // No userId on the job (legacy/anonymous) — fall back to story ownership.
        const ownershipError = await checkStoryOwnership(storyId, userId);
        if (ownershipError) {
            const status = ownershipError === 'Forbidden' ? 403 : ownershipError === 'Unauthorized' ? 401 : 404;
            return res.status(status).json({ success: false, error: ownershipError });
        }
    } else {
        // H9: Fail closed — a job with neither userId nor storyId has no
        // verifiable owner, so full-state must not be disclosed to anyone.
        return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;
    const data = job.data;
    let storyData = null;
    if (state === 'completed' && storyId) {
        // Fix: Use the top-level prisma import instead of a dynamic import().
        // prisma is already imported at the top of the module and is the same
        // lazy getter function — no need to re-import it on every request.
        const story = await prisma().story.findUnique({
            where: { id: storyId },
            include: {
                characters: true,
                episodes: {
                    include: { scenes: { orderBy: { number: 'asc' } } },
                    orderBy: { number: 'asc' },
                },
                environments: true,
                youtubeSeo: true,
            },
        });
        if (story) {
            storyData = story;
        }
    }
    return res.json({
        success: true,
        data: {
            state,
            progress,
            jobId,
            data: {
                ...(data?.genre !== undefined ? { genre: data.genre } : {}),
                ...(data?.seed !== undefined ? { seed: data.seed } : {}),
                ...(data?.webhookUrl !== undefined ? { webhookUrl: data.webhookUrl } : {}),
            },
            story: storyData,
        },
    });
}));

async function checkStoryOwnership(storyId: string, userId: string | undefined): Promise<string | null> {
    if (!userId) return 'Unauthorized';
    const story = await prisma().story.findUnique({
        where: { id: storyId },
        select: { userId: true },
    });
    if (!story) return 'Story not found';
    // HIGH #15: Reject legacy/anonymous stories that have no owner. Treating
    // null-owner stories as public allowed any authenticated user to retrieve
    // full state for stories created before user attribution was enforced.
    if (!story.userId) return 'Forbidden';
    if (story.userId !== userId) return 'Forbidden';
    return null;
}

router.patch('/:storyId/episodes/:episodeNumber', aiLimiter, asyncHandler(async (req, res) => {
    const storyId = String(req.params.storyId);
    if (!ensureValidStoryId(storyId, res)) return;
    const episodeNumber = parseInt(String(req.params.episodeNumber), 10);

    const maxEpisode = getEpisodesPerStory();
    if (Number.isNaN(episodeNumber) || episodeNumber < 1 || episodeNumber > maxEpisode) {
        return res.status(400).json({
            success: false,
            error: 'Invalid episode number',
            message: `Episode number must be between 1 and ${maxEpisode}`,
        });
    }

    const authReq = req as AuthenticatedRequest;
    const ownershipError = await checkStoryOwnership(storyId, authReq.user?.sub);
    if (ownershipError) {
        const status = ownershipError === 'Forbidden' ? 403 : ownershipError === 'Unauthorized' ? 401 : 404;
        return res.status(status).json({ success: false, error: ownershipError });
    }

    try {
        const result = await regenerateEpisode(storyId, episodeNumber, authReq.user!.sub, req.requestId);
        res.status(200).json({
            success: true,
            data: result,
            message: `Episode ${episodeNumber} regenerated successfully`,
        });
    } catch (err) {
        if (err instanceof AppError) {
            const { status, body } = appErrorResponse(err, 'Regeneration failed');
            return res.status(status).json(body);
        }
        // M24: log internal error server-side; return a static message.
        logger.error({ err }, 'Regeneration failed');
        const message = 'Regeneration failed';
        return res.status(500).json({ success: false, error: message });
    }
}));

router.patch('/:storyId/episodes/:episodeNumber/scenes/:sceneNumber', aiLimiter, asyncHandler(async (req, res) => {
    const storyId = String(req.params.storyId);
    if (!ensureValidStoryId(storyId, res)) return;
    const episodeNumber = parseInt(String(req.params.episodeNumber), 10);
    const sceneNumber = parseInt(String(req.params.sceneNumber), 10);

    const maxEpisode = getEpisodesPerStory();
    const maxScene = getScenesPerEpisode();
    if (Number.isNaN(episodeNumber) || episodeNumber < 1 || episodeNumber > maxEpisode) {
        return res.status(400).json({
            success: false,
            error: `Invalid episode number (1-${maxEpisode})`,
        });
    }
    if (Number.isNaN(sceneNumber) || sceneNumber < 1 || sceneNumber > maxScene) {
        return res.status(400).json({
            success: false,
            error: `Invalid scene number (1-${maxScene})`,
        });
    }

    const authReq = req as AuthenticatedRequest;
    const ownershipError = await checkStoryOwnership(storyId, authReq.user?.sub);
    if (ownershipError) {
        const status = ownershipError === 'Forbidden' ? 403 : ownershipError === 'Unauthorized' ? 401 : 404;
        return res.status(status).json({ success: false, error: ownershipError });
    }

    try {
        const result = await regenerateScene(storyId, episodeNumber, sceneNumber, authReq.user!.sub, req.requestId);
        res.status(200).json({
            success: true,
            data: result,
            message: `Scene ${sceneNumber} of Episode ${episodeNumber} regenerated successfully`,
        });
    } catch (err) {
        if (err instanceof AppError) {
            const { status, body } = appErrorResponse(err, 'Regeneration failed');
            return res.status(status).json(body);
        }
        // M24: log internal error server-side; return a static message.
        logger.error({ err }, 'Regeneration failed');
        const message = 'Regeneration failed';
        return res.status(500).json({ success: false, error: message });
    }
}));

router.post('/:storyId/regenerate', aiLimiter, asyncHandler(async (req, res) => {
    const oldStoryId = String(req.params.storyId);
    if (!ensureValidStoryId(oldStoryId, res)) return;

    const authReq = req as AuthenticatedRequest;
    const ownershipError = await checkStoryOwnership(oldStoryId, authReq.user?.sub);
    if (ownershipError) {
        const status = ownershipError === 'Forbidden' ? 403 : ownershipError === 'Unauthorized' ? 401 : 404;
        return res.status(status).json({ success: false, error: ownershipError });
    }

    try {
        // H26: The default 5-minute request socket timeout destroys the
        // connection before a full-story regeneration (~7+ min at 10 episodes)
        // can answer — the client saw an empty response instead of the result
        // or the 504 JSON. Extend the socket timeout for this route beyond the
        // regeneration wall-clock so the outcome always reaches the client.
        req.setTimeout(getRegenerationTimeoutMs() + 60_000);
        const result = await regenerateStory(oldStoryId, authReq.user!.sub);
        res.status(200).json({
            success: true,
            data: result,
            message: 'Story regenerated and atomically replaced',
        });
    } catch (err) {
        if (err instanceof AppError) {
            const { status, body } = appErrorResponse(err, 'Regeneration failed');
            return res.status(status).json(body);
        }
        // M24: log internal error server-side; return a static message.
        logger.error({ err }, 'Regeneration failed');
        const message = 'Regeneration failed';
        return res.status(500).json({ success: false, error: message });
    }
}));

export const generationRouter = router;
