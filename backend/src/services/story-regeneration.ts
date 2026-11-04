import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { logger } from './logger.js';
import { runStoryPipeline } from '../queue/workers/story.worker.js';
import { replaceStoryAtomically, DuplicateStoryError } from '../database/prisma-storage.js';
import { markJobFailed, deleteJobCandidate } from '../queue/redis-pubsub.js';
import { scanObjectForMonetization } from '../lib/copyright-filter.js';
import { withWallClockTimeout } from '../lib/watchdog.js';
import { convertStory } from '../database/prisma-storage.js';
import { getEpisodesPerStory } from '../lib/timing.js';
import { writeAuditLog } from './audit-log.js';
import { checkTokenBudget } from './token-budget.js';
import { getStoryTokenBudgetEstimate } from '../config/env.js';

// H26: Scale the regeneration wall-clock with the story size. A fixed 5-minute
// timeout was shorter than the real 10-episode pipeline (~7 min observed
// live), so full-story regeneration failed 100% of the time at the standard
// configuration. Budget: ~60s per episode (scene generation dominates) plus
// 2 minutes of stage/quality/SEO/persist overhead, with a 6-minute floor for
// small episode counts.
export function getRegenerationTimeoutMs(): number {
    return Math.max(6 * 60 * 1000, getEpisodesPerStory() * 60 * 1000 + 2 * 60 * 1000);
}



export interface RegenerateStoryResult {
    storyId: string;
    replacedStoryId: string;
}

export async function regenerateStory(oldStoryId: string, userId: string): Promise<RegenerateStoryResult> {
    // REGEN-FAST: Load the FULL existing story (episodes, scenes, characters,
    // environments, youtubeSeo) so we can pass it as `preloadedStory` to the
    // pipeline. The orchestrator converts it to a StoryCheckpoint, seeds the
    // candidate JSON, and marks stages 1-4 (uniqueness, blueprint, character
    // bible, world bible) as done. Each of those stages early-returns at
    // its `isStageDone` check and rehydrates stageCtx from the candidate —
    // so regeneration re-uses the previous run's bibles and only re-rolls
    // episodes (stage 5) and downstream stages 7-11. The 3 bible-stage AI
    // calls (~50-60s of bible-generation time) are skipped, dropping regen from
    // ~3.5min / 100+ AI calls to ~1min / 70-80 calls.
    const existing = await prisma().story.findUnique({
        where: { id: oldStoryId },
        include: {
            characters: true,
            environments: true,
            episodes: { include: { scenes: true }, orderBy: { number: 'asc' } },
            youtubeSeo: true,
        },
    });

    if (!existing) {
        throw Object.assign(new Error('Story not found'), { statusCode: 404 });
    }

    // LOW #62: Re-validate ownership in the service layer even though the route
    // already gates this. This prevents accidental authorization bypass if the
    // service is ever called from an admin endpoint or batch job.
    if (existing.userId !== userId) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    // Convert the Prisma row to the Story shape the pipeline expects
    // (convertStory runs in O(N) over episodes/scenes and is safe to call
    // here even if the result is just used as a preloaded checkpoint).
    const preloadedStory = convertStory(existing);

    const requestId = randomUUID();
    const jobId = `regen-${requestId}`;

    logger.info({ oldStoryId, genre: existing.genre, jobId }, 'Atomic regeneration started');

    // M38: gate on the token budget explicitly — episode/scene regeneration
    // services do this; story regeneration relied solely on the pipeline's
    // internal Stage-0 gate, which is bypassable via preloadedStory and
    // return-candidate paths.
    // M28: Reserve an atomic per-job budget estimate so concurrent regenerations
    // cannot pass the read-only gate and then collectively overshoot the budget.
    const budget = await checkTokenBudget({ estimatedTotal: getStoryTokenBudgetEstimate(), jobId });
    if (!budget.ok) {
        throw Object.assign(new Error(budget.reason || 'Token budget exceeded'), { statusCode: 429 });
    }

    let candidate: unknown;

    try {
        const seedValue = existing.seed ?? existing.theme ?? undefined;
        const pipelineResult = await withWallClockTimeout(
            runStoryPipeline({
                genre: [existing.genre],
                ...(seedValue !== undefined ? { seed: seedValue } : {}),
                // H26c: thread the owner id through — the candidate Story is
                // validated by replaceStoryAtomically's isStoryInput, which
                // requires userId. Without it, every regeneration failed with
                // 500 "Invalid story payload" after completing the pipeline
                // (verified live).
                userId,
                jobId,
                requestId,
                persistMode: 'return-candidate',
                preloadedStory,
                tokenBudgetEstimate: getStoryTokenBudgetEstimate(),
            }),
            // H26: computed per call — episodesPerStory is a live binding that
            // loadTimingOverrides updates from system settings.
            getRegenerationTimeoutMs(),
            'story-regeneration',
            jobId
        ) as { story: unknown };
        candidate = pipelineResult.story;
    } catch (err) {
        if ((err as { code?: string }).code === 'WALLCLOCK_TIMEOUT') {
            await Promise.all([
                markJobFailed(jobId, 'Regeneration timed out after 5 minutes'),
                deleteJobCandidate(jobId),
            ]).catch((e) => logger.warn({ err: e, jobId }, 'Failed to cleanup timed-out job state in Redis'));
            throw Object.assign(new Error('Regeneration timed out'), { statusCode: 504 });
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ oldStoryId, jobId, err: errMsg }, 'Regeneration pipeline failed');
        // M38: clean up Redis job/candidate state on NON-timeout failures too
        // — previously only the WALLCLOCK_TIMEOUT branch cleaned up, leaving
        // regen-<uuid> state in Redis until TTL.
        await Promise.all([
            markJobFailed(jobId, errMsg),
            deleteJobCandidate(jobId),
        ]).catch((e) => logger.warn({ err: e, jobId }, 'Failed to cleanup failed job state in Redis'));
        throw Object.assign(new Error(errMsg), { statusCode: 500 });
    }

    if (!candidate) {
        throw Object.assign(new Error('Regeneration returned no candidate story.'), { statusCode: 500 });
    }

    // H26b: Monetization (advertiser-risk) terms must NOT abort regeneration.
    // Stage 10 of the pipeline already redacted them from the public YouTube
    // listing — the exact semantic the in-pipeline sweep implements ("do NOT
    // abort; only sanitize the listing"). Rejecting here contradicted that
    // policy and burned a full regeneration's AI spend for any candidate that
    // drifted into advertiser-risk vocabulary (verified live: a valid regen
    // failed with "Blocked terms: slaughter" after completing the pipeline).
    const monHits = scanObjectForMonetization(candidate);
    if (monHits.length > 0) {
        logger.warn({ oldStoryId, jobId, hits: monHits }, 'Monetization terms present in regenerated candidate — listing already redacted by stage 10; proceeding');
    }

    let replaced;
    try {
        replaced = await replaceStoryAtomically(oldStoryId, candidate, userId);
    } catch (err) {
        if (err instanceof DuplicateStoryError) {
            throw Object.assign(
                new Error(`Cannot regenerate: the resulting story would duplicate "${existing.seed ?? existing.theme ?? 'an existing story'}"`),
                { statusCode: 409, duplicateError: err }
            );
        }
        throw err;
    }

    // M29: audit the regeneration — a full-story replacement is a destructive
    // delete+create and previously left no audit trail (REGENERATE was defined
    // but never used).
    await writeAuditLog({
        action: 'REGENERATE',
        entityType: 'story',
        entityId: replaced.id,
        before: { storyId: oldStoryId, title: existing.title },
        after: { storyId: replaced.id, title: (replaced as { title?: string }).title },
        userId,
    });

    logger.info({ oldStoryId, newStoryId: replaced.id }, 'Atomic regeneration complete');

    return { storyId: replaced.id, replacedStoryId: oldStoryId };
}
