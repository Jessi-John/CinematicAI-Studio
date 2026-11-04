import { prisma } from '../database/prisma.js';
import { logger } from './logger.js';
import { generateSingleScene, isSceneTooSimilar } from '../lib/episode-generator.js';
import { buildScenePrompts } from '../lib/prompt-engine.js';
import { checkNewContentSimilarity } from './similarity.js';
import { checkMonetization } from '../lib/copyright-filter.js';
import { durationFromWords, timingFor, episodesPerStory, scenesPerEpisode } from '../lib/timing.js';
import { toRichCharacter, toRichEnvironment } from '../lib/db-to-rich.js';
import { buildVoiceoverText } from '../lib/tts-normalize.js';
import { buildCharacterBible, findCharacters } from './generation-helpers.js';
import { logRegeneration } from './generation-logger.js';
import { writeAuditLog } from './audit-log.js';
import { runWithAIPipelineContext } from '../lib/ai-client.js';
import { checkTokenBudget, refundTokenBudget, clearTokenSpend } from './token-budget.js';
import { getSceneTokenBudgetEstimate } from '../config/env.js';
import { Prisma } from '@prisma/client';

export interface RegenerateSceneResult {
    episodeNumber: number;
    sceneNumber: number;
    regenerated: boolean;
    newNarration: string;
    retryCount: number;
}

export async function regenerateScene(
    storyId: string,
    episodeNumber: number,
    sceneNumber: number,
    userId: string,
    contextJobId?: string
): Promise<RegenerateSceneResult> {
    const resolvedJobId = contextJobId ?? `regen-scene-${storyId}-${episodeNumber}-${sceneNumber}`;

    // M14: Use configurable limits instead of hardcoded 10/5.
    if (episodeNumber < 1 || episodeNumber > episodesPerStory) {
        throw Object.assign(new Error('Invalid episode number'), { statusCode: 400 });
    }
    if (sceneNumber < 1 || sceneNumber > scenesPerEpisode) {
        throw Object.assign(new Error('Invalid scene number'), { statusCode: 400 });
    }

    const existing = await prisma().story.findUnique({
        where: { id: storyId },
        include: {
            characters: true,
            environments: true,
            episodes: {
                orderBy: { number: 'asc' as const },
                include: { scenes: { orderBy: { number: 'asc' as const } } },
            },
        },
    });

    if (!existing) {
        throw Object.assign(new Error('Story not found'), { statusCode: 404 });
    }

    // LOW #62: Re-validate ownership in the service layer even though the route
    // already gates this.
    if (existing.userId !== userId) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const episode = existing.episodes.find((e) => e.number === episodeNumber);
    if (!episode) {
        throw Object.assign(new Error('Episode not found'), { statusCode: 404 });
    }

    const scene = episode.scenes.find((s) => s.number === sceneNumber);
    if (!scene) {
        throw Object.assign(new Error('Scene not found'), { statusCode: 404 });
    }

    const { protagonist, antagonist, supporting, environment } = findCharacters(existing);
    const characterBible = buildCharacterBible(protagonist);

    const previousScenes = episode.scenes
        .filter((s) => s.number < sceneNumber)
        .sort((a, b) => a.number - b.number)
        .map((s) => s.narrationText);

    const priorEpisodeScenes = existing.episodes
        .filter((e) => e.number < episodeNumber)
        .flatMap((e) => e.scenes.map((s) => s.narrationText));

    // Collect narration from ALL other episodes as cross-episode context
    // for the AI prompt. Unlike priorEpisodeScenes (which only includes
    // chronologically earlier episodes for validation), this includes ALL
    // other episodes so the model can see the full story's existing narration
    // and avoid duplicating any phrasing.
    const otherEpisodeNarrations = existing.episodes
        .filter((e) => e.number !== episodeNumber)
        .flatMap((e) => e.scenes.map((s) => s.narrationText));

    let newNarration = '';
    let retryCount = 0;
    const maxRetries = 5;

    // H4 FIX / M28: Gate on the budget with an atomic reservation so concurrent
    // regenerations cannot all pass a read-only check and then overspend the
    // budget. Actual usage is recorded per-call by the AI client and reconciled
    // by clearTokenSpend/refundTokenBudget at the end of the flow.
    const budget = await checkTokenBudget({
      estimatedTotal: getSceneTokenBudgetEstimate(),
      jobId: resolvedJobId,
    });
    if (!budget.ok) {
      throw Object.assign(
        new Error(`Token budget rejected scene regeneration: ${budget.reason}`),
        { statusCode: 429, code: 'TOKEN_BUDGET_EXCEEDED' }
      );
    }

    // H4: Wrap the whole flow in try/finally. Previously there was NO refund
    // wrapper, so the 409 (similarity/version-conflict) and 422 (monetization)
    // rejection paths — which run AFTER the AI call had already consumed
    // tokens — leaked the charged budget. Now ANY failure refunds the ACTUAL
    // tokens the AI client consumed (tracked per jobId), and success clears
    // the tracker so the actual charges stand.
    let success = false;
    try {
        // H13: Track acceptance explicitly. Previously the loop exited after
        // the final attempt with newNarration holding content that had JUST
        // FAILED the quality gates (meta-words or too-similar), and the
        // post-loop guard only checked length — so invalid content flowed
        // into humanization and persistence with success returned.
        let accepted = false;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const protagonistGender = protagonist?.gender === 'male' || protagonist?.gender === 'female'
                    ? protagonist.gender
                    : 'neutral';
                newNarration = await runWithAIPipelineContext(resolvedJobId, null, () =>
                    generateSingleScene(
                        sceneNumber,
                        episodeNumber,
                        existing.title,
                        protagonist?.name || 'Unknown',
                        existing.genre,
                        episode.synopsis,
                        previousScenes[previousScenes.length - 1] || null,
                        characterBible,
                        true,
                        undefined,
                        protagonistGender,
                        undefined,
                        undefined,
                        otherEpisodeNarrations
                    )
                );
                // H13b: word-boundary keyword check — 'hook'/'synopsis' as
                // substrings false-positive on legitimate prose ("a fish hook",
                // "off the hook").
                const lowerNarration = newNarration.toLowerCase();
                const hasMetaWord = /\bhook\b|\bsynopsis\b/.test(lowerNarration);
                if (newNarration.length >= 15 &&
                    !hasMetaWord &&
                    !isSceneTooSimilar(newNarration, priorEpisodeScenes)) {
                    accepted = true;
                    break;
                }
                retryCount += 1;
            } catch (err) {
                logger.warn({ err, attempt: attempt + 1 }, 'Scene regeneration attempt failed');
                retryCount += 1;
                await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
        }

        if (!accepted) {
            // H13: All retries failed quality gates. Refund the actual tokens
            // consumed and fail the regeneration instead of persisting content
            // that violates the service's own acceptance criteria.
            await refundTokenBudget(resolvedJobId, 0, 0);
            throw Object.assign(new Error('Scene regeneration failed quality gates after all retries'), {
                statusCode: 502,
                code: 'REGEN_QUALITY_FAILED',
            });
        }

        if (!newNarration || newNarration.length < 15) {
            // Unreachable after the H13 accepted-flag guard (a <15-char
            // narration can never set accepted=true), kept as a defensive
            // fallback for future loop changes.
            await refundTokenBudget(resolvedJobId, 0, 0);
            newNarration =
                `The journey continues as ${protagonist?.name || 'the protagonist'} faces a crucial moment. Something important waits to be discovered.`;
        }

        const { humanization } = await import('../humanization/index.js');
        newNarration = humanization.process(newNarration).text;

        const similarity = await checkNewContentSimilarity(existing.genre, newNarration, existing.id, resolvedJobId, existing.userId);
        if (similarity > 0.85) {
            throw Object.assign(new Error(`Regenerated content too similar to an existing story (score ${similarity.toFixed(2)})`), {
                statusCode: 409,
                similarityScore: similarity,
            });
        }

        const monetization = checkMonetization(newNarration);
        if (!monetization.clean) {
            throw Object.assign(new Error(`Blocked terms: ${monetization.hits.join(', ')}`), {
                statusCode: 422,
                blockedTerms: monetization.hits,
            });
        }

        const wordCount = newNarration.split(/\s+/).length;
        const newDuration = durationFromWords(wordCount);
        const protagonistRich = protagonist ? toRichCharacter(protagonist) : undefined;
        const antagonistRich = antagonist ? toRichCharacter(antagonist) : undefined;
        const supportingRich = supporting ? toRichCharacter(supporting) : undefined;
        const envRich = environment ? toRichEnvironment(environment) : undefined;

        const prompts = protagonistRich && envRich
            ? buildScenePrompts({
                genre: existing.genre,
                episodeNumber,
                sceneIndex: sceneNumber - 1,
                narrationText: newNarration,
                protagonist: protagonistRich,
                ...(antagonistRich !== undefined ? { antagonist: antagonistRich } : {}),
                ...(supportingRich !== undefined ? { supporting: supportingRich } : {}),
                environment: envRich,
                ...(characterBible !== undefined ? { characterBible } : {}),
                ...(previousScenes.length > 0 ? { previousNarration: previousScenes[previousScenes.length - 1] } : {}),
            })
            : null;

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
                await tx.$executeRaw`SELECT 1 FROM "scenes" WHERE id = ${scene.id} FOR UPDATE`;
                const current = await tx.scene.findUnique({
                    where: { id: scene.id },
                    select: { version: true },
                });
                if (!current) {
                    const err = new Error('Scene not found') as Error & { code?: string };
                    err.code = 'P2025';
                    throw err;
                }
                await tx.scene.update({
                    where: { id: scene.id, version: current.version },
                    data: {
                        narrationText: newNarration,
                        narrationEmotion: prompts?.emotion || scene.narrationEmotion,
                        duration: newDuration,
                        narrationTiming: timingFor(newDuration),
                        imagePromptContent: prompts?.imagePrompt ||
                            `Cinematic painterly anime scene: ${newNarration.substring(0, 50)}...`,
                        videoPromptContent: prompts?.videoPrompt || `Cinematic painterly anime motion: ${newNarration}`,
                        cameraType: prompts?.cameraDirection.type || scene.cameraType,
                        cameraMovement: prompts?.cameraDirection.movement || scene.cameraMovement,
                        cameraAngle: prompts?.cameraDirection.angle || scene.cameraAngle,
                        cameraLens: prompts?.cameraDirection.lens || scene.cameraLens,
                        emotionalIntensity: prompts?.emotionalIntensity ?? scene.emotionalIntensity,
                        transitionType: prompts?.transitionType || scene.transitionType,
                        characterState: (prompts?.characterState ?? scene.characterState) as Prisma.InputJsonValue,
                        environmentState: (prompts?.environmentState ?? scene.environmentState) as Prisma.InputJsonValue,
                        version: current.version + 1,
                    },
                });
            });
        } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'P2025') {
                throw Object.assign(new Error('Conflict: Scene was modified by another request. Refresh and try again.'), {
                    statusCode: 409,
                    code: 'VERSION_CONFLICT',
                });
            }
            throw err;
        }

        await logRegeneration({
            type: 'scene',
            storyId,
            episodeId: episode.id,
            episodeNumber,
            sceneNumber,
            oldValue: scene.narrationText,
            newValue: newNarration,
            reason: `retry_count:${retryCount}`,
        });

        // M29: audit the scene regeneration.
        await writeAuditLog({
            action: 'REGENERATE',
            entityType: 'scene',
            entityId: `${storyId}#${episodeNumber}.${sceneNumber}`,
            before: { narrationText: scene.narrationText.slice(0, 200) },
            after: { narrationText: newNarration.slice(0, 200) },
            userId,
        });

        // Refresh the parent episode's voiceoverText so the TTS export reflects the regenerated scene.
        try {
            const refreshed = await prisma().episode.findUnique({
                where: { id: episode.id },
                include: { scenes: { orderBy: { number: 'asc' as const } } },
            });
            if (refreshed) {
                await prisma().episode.update({
                    where: { id: episode.id },
                    data: {
                        voiceoverText: buildVoiceoverText({
                            hook: refreshed.hook,
                            scenes: refreshed.scenes.map((s) => s.narrationText),
                            cliffhanger: refreshed.cliffhanger,
                        }),
                    },
                });
            }
        } catch (err) {
            logger.warn({ err, storyId, episodeId: episode.id }, 'Failed to refresh episode voiceoverText after scene regen');
        }

        success = true;
        // H4: Actual charges stand — clear the per-job spend tracker.
        clearTokenSpend(resolvedJobId);
        return { episodeNumber, sceneNumber, regenerated: true, newNarration, retryCount };
    } finally {
        if (!success) {
            // H4: Refund the ACTUAL tokens the AI client consumed (tracked per
            // jobId) on any rejection/failure path (similarity 409, monetization
            // 422, version-conflict 409, or an unexpected throw). 0,0 →
            // refundTokenBudget uses the tracked cumulative spend.
            await refundTokenBudget(resolvedJobId, 0, 0).catch((refundErr) =>
                logger.warn({ jobId: resolvedJobId, err: refundErr }, 'Scene regeneration token refund failed')
            );
        }
    }
}
