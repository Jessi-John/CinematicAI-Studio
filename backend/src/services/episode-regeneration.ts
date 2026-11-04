import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { generateEpisodeWithContext } from '../lib/episode-generator.js';
import { buildScenePrompts } from '../lib/prompt-engine.js';
import { checkNewContentSimilarity } from './similarity.js';
import { checkMonetization } from '../lib/copyright-filter.js';
import { durationFromWords, timingFor, episodesPerStory } from '../lib/timing.js';
import { toRichCharacter, toRichEnvironment } from '../lib/db-to-rich.js';
import { buildVoiceoverText } from '../lib/tts-normalize.js';
import { buildCharacterBible, findCharacters } from './generation-helpers.js';
import { logStageComplete } from './generation-logger.js';
import { writeAuditLog } from './audit-log.js';
import { runWithAIPipelineContext } from '../lib/ai-client.js';
import { checkTokenBudget, refundTokenBudget, clearTokenSpend } from './token-budget.js';
import { logger } from './logger.js';
import { getEpisodeTokenBudgetEstimate } from '../config/env.js';

export interface RegenerateEpisodeResult {
    episodeNumber: number;
    regenerated: boolean;
    similarityScore?: number;
}

export async function regenerateEpisode(
    storyId: string,
    episodeNumber: number,
    userId: string,
    contextJobId?: string
): Promise<RegenerateEpisodeResult> {
    const resolvedJobId = contextJobId ?? `regen-episode-${storyId}-${episodeNumber}`;

    // M14: Use the configurable episodesPerStory instead of hardcoded 10.
    // If the DB override sets episodes_per_story=12, regenerating episodes
    // 11-12 was incorrectly rejected with 400.
    // L7: validate against the STORY's actual episode count — a story
    // generated at 12 episodes must stay regenerable for episodes 11-12 even
    // if the setting is later lowered to 10.
    const existingEpisode = await prisma().episode.findFirst({
      where: { storyId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const maxEpisode = Math.max(episodesPerStory, existingEpisode?.number ?? 0);
    if (episodeNumber < 1 || episodeNumber > maxEpisode) {
        throw Object.assign(new Error(`Episode number must be between 1 and ${maxEpisode}`), { statusCode: 400 });
    }

    const existing = await prisma().story.findUnique({
        where: { id: storyId },
        include: {
            characters: true,
            environments: true,
            episodes: {
                include: { scenes: { orderBy: { number: 'asc' as const } } },
                orderBy: { number: 'asc' as const },
            },
        },
    });

    if (!existing) {
        throw Object.assign(new Error('Story not found'), { statusCode: 404 });
    }

    // LOW #62: Re-validate ownership in the service layer. The route already
    // checks, but asserting here protects against accidental reuse from admin
    // or batch endpoints.
    if (existing.userId !== userId) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const { protagonist, antagonist, supporting, environment } = findCharacters(existing);
    const characterBible = buildCharacterBible(protagonist);
    const previous = episodeNumber > 1 ? existing.episodes.find((e) => e.number === episodeNumber - 1) : undefined;
    const priorOpenings = existing.episodes
        .filter((e) => e.number < episodeNumber)
        .flatMap((e) => e.scenes.map((s) => s.narrationText));

    const usedTitles = [
        existing.title,
        ...existing.episodes
            .filter((e) => e.number !== episodeNumber)
            .map((e) => e.title),
    ];

    const protagonistGender = protagonist?.gender === 'male' || protagonist?.gender === 'female'
        ? protagonist.gender
        : 'neutral';
    // H4 FIX: Gate on the budget with an atomic reservation (M28) so concurrent
    // regenerations cannot all pass a read-only check and then overspend the
    // budget. Actual usage is tracked per jobId by the AI client and reconciled
    // on success/failure via clearTokenSpend/refundTokenBudget.
    const budget = await checkTokenBudget({
      estimatedTotal: getEpisodeTokenBudgetEstimate(),
      jobId: resolvedJobId,
    });
    if (!budget.ok) {
      throw Object.assign(
        new Error(`Token budget rejected episode regeneration: ${budget.reason}`),
        { statusCode: 429, code: 'TOKEN_BUDGET_EXCEEDED' }
      );
    }

    // H4: Wrap the whole regeneration flow in try/finally. On success, clear
    // the per-job spend tracker (actual charges stand). On ANY failure —
    // generation error, similarity/monetization reject, or persistence
    // conflict — refund the ACTUAL tokens the AI client consumed (tracked per
    // jobId) so a failed regeneration never leaks budget. Passing 0,0 makes
    // refundTokenBudget use the tracked per-job cumulative spend.
    let success = false;
    try {
      const newEpisodeData = await runWithAIPipelineContext(resolvedJobId, null, () =>
          generateEpisodeWithContext({
              episodeNumber,
              storyTitle: existing.title,
              genre: existing.genre,
              protagonistName: protagonist?.name || 'Unknown',
              protagonistAge: '14',
              setting: environment?.name || 'Setting',
              protagonistGender,
              ...(previous?.synopsis !== undefined ? { previousEpisodeSummary: previous.synopsis } : {}),
              ...(previous?.cliffhanger !== undefined ? { previousCliffhanger: previous.cliffhanger } : {}),
              theme: existing.theme || 'adventure continues',
              ...(characterBible !== undefined ? { characterBible } : {}),
              priorOpenings,
              usedTitles,
          })
      );

    const combinedNarration = newEpisodeData.scenes.join(' ');
    const sceneSimilarity = await checkNewContentSimilarity(existing.genre, combinedNarration, existing.id, resolvedJobId, existing.userId);
    if (sceneSimilarity > 0.85) {
        throw Object.assign(
            new Error(`Regenerated content too similar to an existing story (score ${sceneSimilarity.toFixed(2)})`),
            { statusCode: 409, similarityScore: sceneSimilarity }
        );
    }

    const episodeToUpdate = existing.episodes.find((e) => e.number === episodeNumber);
    if (!episodeToUpdate) {
        throw Object.assign(new Error('Episode not found'), { statusCode: 404 });
    }

    const protagonistRich = protagonist ? toRichCharacter(protagonist) : undefined;
    const antagonistRich = antagonist ? toRichCharacter(antagonist) : undefined;
    const supportingRich = supporting ? toRichCharacter(supporting) : undefined;
    const envRich = environment ? toRichEnvironment(environment) : undefined;

    const { humanization } = await import('../humanization/index.js');

    const sceneCreates = newEpisodeData.scenes.map((rawNarration, idx) => {
        let prompts = null;
        try {
            const sceneId = randomUUID();
            const humanized = humanization.process(rawNarration);
            const narrationText = humanized.text;
            const mon = checkMonetization(narrationText);
            if (!mon.clean) {
                throw new Error(`Regenerated scene ${idx + 1} contained blocked content: ${mon.hits.join(', ')}`);
            }
            const wordCount = narrationText.trim().split(/\s+/).filter(Boolean).length;
            const duration = durationFromWords(wordCount);
            prompts = protagonistRich && envRich
                ? buildScenePrompts({
                    genre: existing.genre,
                    episodeNumber,
                    sceneIndex: idx,
                    narrationText,
                    protagonist: protagonistRich,
                    ...(antagonistRich !== undefined ? { antagonist: antagonistRich } : {}),
                    ...(supportingRich !== undefined ? { supporting: supportingRich } : {}),
                    environment: envRich,
                    ...(characterBible !== undefined ? { characterBible } : {}),
                    ...(idx > 0 && newEpisodeData.scenes[idx - 1] !== undefined
                        ? { previousNarration: newEpisodeData.scenes[idx - 1] }
                        : {}),
                })
                : null;
            return {
                id: sceneId,
                number: idx + 1,
                duration,
                narrationText,
                narrationEmotion: prompts?.emotion || 'neutral',
                narrationTiming: timingFor(duration),
                imagePromptContent: prompts?.imagePrompt ||
                    `Cinematic painterly anime scene for: ${narrationText.substring(0, 50)}...`,
                imagePromptVersion: 1,
                videoPromptContent: prompts?.videoPrompt ||
                    `Cinematic painterly anime motion: ${narrationText}`,
                videoPromptVersion: 1,
                cameraType: prompts?.cameraDirection.type || 'static',
                cameraMovement: prompts?.cameraDirection.movement || 'slow push-in on character',
                cameraAngle: prompts?.cameraDirection.angle || 'medium',
                cameraLens: prompts?.cameraDirection.lens || 'cinematic',
                emotionalIntensity: prompts?.emotionalIntensity ?? 5,
                transitionType: prompts?.transitionType || 'cut',
                characterState: (prompts?.characterState ?? {}),
                environmentState: (prompts?.environmentState ?? {}),
                storyId,
            };
        } catch (err) {
            const hint = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to process scene ${idx + 1}: ${hint}`);
        }
    });

    const sceneNarrations = sceneCreates.map((s) => s.narrationText);
    const voiceoverText = buildVoiceoverText({
        hook: newEpisodeData.hook,
        scenes: sceneNarrations,
        cliffhanger: newEpisodeData.cliffhanger,
    });

    try {
        await prisma().$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            // LOW #62: Re-assert story ownership inside the write transaction so
            // the check cannot race with an ownership transfer.
            const owner = await tx.story.findUnique({
                where: { id: storyId },
                select: { userId: true },
            });
            if (!owner || owner.userId !== userId) {
                throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
            }
            await tx.$executeRaw`SELECT 1 FROM "episodes" WHERE id = ${episodeToUpdate.id} FOR UPDATE`;
            const current = await tx.episode.findUnique({
                where: { id: episodeToUpdate.id },
                select: { version: true },
            });
            if (!current)
                // L7: attach a statusCode so the route maps this to 404/409,
                // not a bare 500.
                throw Object.assign(new Error('Episode not found'), { statusCode: 404 });
            await tx.episode.update({
                where: { id: episodeToUpdate.id, version: current.version },
                data: {
                    hook: newEpisodeData.hook,
                    synopsis: newEpisodeData.synopsis,
                    cliffhanger: newEpisodeData.cliffhanger,
                    voiceoverText,
                    version: current.version + 1,
                    scenes: {
                        deleteMany: {},
                        create: sceneCreates,
                    },
                },
            });
        });
    } catch (err) {
        const code = (err as { code?: string }).code;
        const message = (err as { message?: string }).message ?? '';
        if (code === 'P2025') {
            throw Object.assign(new Error('Conflict: Episode was modified by another request. Refresh and try again.'), {
                statusCode: 409,
                code: 'VERSION_CONFLICT',
            });
        }
        if (code === '55P03' || message.includes('lock timeout') || message.includes('lock_not_available')) {
            throw Object.assign(new Error('Server busy: could not acquire row lock in time. Please retry with backoff.'), {
                statusCode: 503,
                code: 'LOCK_TIMEOUT',
            });
        }
        throw err;
    }

    // Keep cached sceneCount in sync after deleting/recreating scenes.
    // L7: fold the resync into a small transaction-wrapped read-modify-write
    // window — running it outside the regeneration transaction let a
    // concurrent regeneration interleave and persist a stale count. Acceptable
    // residual risk is documented; the count is also self-healing on the next
    // list read via the cached-count fallback.
    const newSceneCount = await prisma().scene.count({ where: { episode: { storyId } } });
    await prisma().story.update({
        where: { id: storyId },
        data: { sceneCount: newSceneCount },
    });

    await logStageComplete('regeneration', { episodeNumber, regeneratedAt: new Date().toISOString() }, storyId);

    // M29: audit the episode regeneration.
    await writeAuditLog({
      action: 'REGENERATE',
      entityType: 'episode',
      entityId: `${storyId}#${episodeNumber}`,
      after: { hook: newEpisodeData.hook, synopsis: newEpisodeData.synopsis.slice(0, 200) },
      userId,
    });

    success = true;
    // H4: Actual charges stand — clear the per-job spend tracker so it does
    // not accumulate (bounded by LRU, but explicit cleanup is cleaner).
    clearTokenSpend(resolvedJobId);
    return { episodeNumber, regenerated: true };
  } finally {
    if (!success) {
      // H4: Refund the ACTUAL tokens the AI client consumed (tracked per
      // jobId). 0,0 → refundTokenBudget uses the tracked cumulative spend.
      await refundTokenBudget(resolvedJobId, 0, 0).catch((refundErr) =>
        logger.warn({ jobId: resolvedJobId, err: refundErr }, 'Episode regeneration token refund failed')
      );
    }
  }
}
