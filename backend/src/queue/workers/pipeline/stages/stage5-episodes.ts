/**
 * Stage 5: Episode generation.
 *
 * The longest-running stage — generates the full story (10 episodes × 5 scenes
 * with parallel meta-then-parallel-scene passes). On completion, the
 * assembled story is checkpointed to the candidate key so a stall / lock-loss
 * in a later stage can be resumed by reading the candidate.
 *
 * Rel-005 / ARCH-003 / ARCH-004 invariants live here:
 *   - save the candidate BEFORE markStageDone, so a reload never sees
 *     "episodes done" but no candidate.
 *   - the per-episode opening-phrase feed-forward reduces the chance of two
 *     consecutive scenes starting with the same words.
 */

import type { StageContext, StageHelpers } from '../types.js';
import {
  generateEpisodeMetaOnly,
  generateScenesForEpisode,
  rebalanceScenesDuration,
  deduplicateCrossEpisodeScenes,
  type GeneratedEpisode,
} from '../../../../lib/episode-generator.js';
import { ensureEpisodeWordCompliance } from '../../../../lib/word-count-compliance.js';
import { buildStoryFromEpisodes } from '../../../../lib/story-builder.js';
// M21: ctx.episodesPerStory is now read from ctx (frozen per-job)
import { logger } from '../../../../services/logger.js';
import { defaultCharacterBible } from '../helpers.js';

export async function stage5Episodes(
  ctx: StageContext,
  { progressEmit, isStageDone, markStageDone, loadCandidate, saveCandidate }: StageHelpers
): Promise<void> {
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  if (await isStageDone('episodes')) {
    await progressEmit(20, 'episodes', 'Skipping episodes (already completed)...');
    const cachedStory = await loadCandidate();
    if (!cachedStory) throw new Error('No cached candidate found for episodes checkpoint');
    ctx.story = cachedStory;
    ctx.episodes = cachedStory.episodes as unknown as GeneratedEpisode[];
    logger.info(
      { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', elapsedMs: 0, skipped: true },
      'STAGE_COMPLETED'
    );
    return;
  }
  const blueprint = ctx.blueprint!;
  const characterBible = ctx.characterBible ?? defaultCharacterBible();
  const worldBible = ctx.worldBible!;

  // Pass 1: Generate all episode metas sequentially.
  // Episode N's meta depends on episode N-1's meta (episodeSummary + cliffhanger),
  // so each episode must complete before the next one starts to provide continuity.
  // Previously used parallel batches of 3, but that caused episodes 2 and 3 to
  // read `undefined` from the empty episodeMetas array — losing narrative context.
  const stage5StartedAt = process.hrtime.bigint();
  const pass1StartedAt = process.hrtime.bigint();
  const episodeMetas: Array<{ title: string; hook: string; synopsis: string; cliffhanger: string; episodeSummary: string }> = [];
  // H7: Abort mid-stage when the pipeline watchdog has fired — otherwise this
  // stage (the longest, most stall-prone one) keeps an orphaned attempt
  // running for minutes after the timeout.
  const checkAborted = (): void => {
    if (ctx.abortSignal?.aborted) {
      throw new Error(`Pipeline aborted during episode generation (job ${ctx.jobId})`);
    }
  };
  for (let epNum = 1; epNum <= ctx.episodesPerStory; epNum++) {
    checkAborted();
    await progressEmit(
      20 + Math.round(((epNum - 1) / ctx.episodesPerStory) * 50),
      'episodes',
      `Generating episode ${epNum} meta...`
    );
    const epMetaStartNs = process.hrtime.bigint();
    const prevMeta = episodeMetas[epNum - 2]; // episode N-1's meta
    // L4-EP-TITLE: pass the story title and every previously-chosen episode
    // title to the meta prompt. The prompt lists them as a "DO NOT USE"
    // block, and the post-generation validator in episode-generator.ts
    // rejects any match with a focused regeneration. Without this list,
    // the model frequently duplicates the story title (Ep 7) or appends
    // a positional prefix (Ep 8 = "The Undersky Chart: Episode 8 — ...").
    const usedTitles = [blueprint.title, ...episodeMetas.map((m) => m.title)];
    const r = await generateEpisodeMetaOnly({
      episodeNumber: epNum,
      storyTitle: blueprint.title,
      genre: ctx.primaryGenre,
      protagonistName: blueprint.protagonistName,
      protagonistAge: blueprint.protagonistAge,
      setting: blueprint.setting,
      ...(prevMeta !== undefined
        ? { previousEpisodeSummary: prevMeta.episodeSummary, previousCliffhanger: prevMeta.cliffhanger }
        : {}),
      characterBible,
      avoidanceConstraints: ctx.avoidanceConstraints ?? [],
      usedTitles,
    });
    episodeMetas.push(r);
    const epMetaMs = Number(process.hrtime.bigint() - epMetaStartNs) / 1_000_000;
    logger.info(
      {
        jobId: ctx.jobId,
        requestId: ctx.requestId,
        stage: 'episodes',
        sub: 'meta',
        episodeNumber: epNum,
        elapsedMs: Math.round(epMetaMs),
      },
      'STAGE5_META_DONE'
    );
  }
  const pass1Ms = Number(process.hrtime.bigint() - pass1StartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', sub: 'pass1_total', elapsedMs: Math.round(pass1Ms) },
    'STAGE5_PASS1_DONE'
  );

  // Pass 2: Generate scenes for all episodes in parallel using pre-generated meta.
  // Episodes are independent — each episode's scenes depend only on its own meta
  // (title, hook, synopsis, cliffhanger) and the shared world/character bible.
  // Cross-episode scene deduplication (priorOpenings) is skipped for parallelization;
  // within-episode deduplication still applies.
  const pass2StartedAt = process.hrtime.bigint();
  await progressEmit(50, 'episodes', 'Generating scenes for all episodes in parallel...');
  let completedCount = 0;
  const episodeResults = await Promise.all(
    Array.from({ length: ctx.episodesPerStory }, async (_, i) => {
      checkAborted();
      const epNum = i + 1;
      const meta = episodeMetas[i]!;
      const epStartedAt = process.hrtime.bigint();

      const scenes = await generateScenesForEpisode(
        epNum,
        blueprint.title,
        blueprint.protagonistName,
        ctx.primaryGenre,
        meta.synopsis,
        characterBible,
        [],  // No cross-episode scene context — all episodes run in parallel
        meta.hook,
        // M31: thread protagonistGender through to scene narration and
        // any fallback substitutions (was missing before, so the LLM
        // defaulted to female pronouns for fantasy regardless of the
        // protagonist's actual gender).
        blueprint.protagonistGender
      );
      const scenesMs = Number(process.hrtime.bigint() - epStartedAt) / 1_000_000;
      logger.info(
        {
          jobId: ctx.jobId,
          requestId: ctx.requestId,
          stage: 'episodes',
          sub: 'scenes',
          episodeNumber: epNum,
          elapsedMs: Math.round(scenesMs),
        },
        'STAGE5_SCENES_DONE'
      );

      const rebalanceStartedAt = process.hrtime.bigint();
      const rebalanced = await rebalanceScenesDuration(scenes, {
        storyTitle: blueprint.title,
        genre: ctx.primaryGenre,
        protagonistName: blueprint.protagonistName,
        episodeNumber: epNum,
        synopsis: meta.synopsis,
        characterBible,
        // M31: thread protagonistGender through rebalance prompt too
        ...(blueprint.protagonistGender !== undefined ? { protagonistGender: blueprint.protagonistGender } : {}),
      }, []);  // No cross-episode scene context
      const rebalanceMs = Number(process.hrtime.bigint() - rebalanceStartedAt) / 1_000_000;
      logger.info(
        {
          jobId: ctx.jobId,
          requestId: ctx.requestId,
          stage: 'episodes',
          sub: 'rebalance',
          episodeNumber: epNum,
          elapsedMs: Math.round(rebalanceMs),
        },
        'STAGE5_REBALANCE_DONE'
      );

      const epTotalMs = Number(process.hrtime.bigint() - epStartedAt) / 1_000_000;
      logger.info(
        {
          jobId: ctx.jobId,
          requestId: ctx.requestId,
          stage: 'episodes',
          sub: 'episode_total',
          episodeNumber: epNum,
          elapsedMs: Math.round(epTotalMs),
          scenes: scenes.length,
          wordTotal: rebalanced.reduce((s, t) => s + t.split(/\s+/).filter(Boolean).length, 0),
        },
        'STAGE5_EPISODE_DONE'
      );

      completedCount += 1;
      const subProgress = 50 + Math.round((completedCount / ctx.episodesPerStory) * 25);
      await progressEmit(subProgress, 'episodes', `Scene generation ${completedCount}/${ctx.episodesPerStory} episodes complete...`);
      return { ...meta, scenes: rebalanced } as GeneratedEpisode;
    })
  );
  // Promise.all preserves input order — results[i] corresponds to episode i+1
  // Cross-episode deduplication replaces scenes that are too similar across
  // episodes (dedup was sacrificed when Pass 2 was parallelized).
  // M31: thread protagonistGender through to the fallback picker so
  // replaced scenes use the correct pronouns.
  const episodes = deduplicateCrossEpisodeScenes(
    episodeResults,
    ctx.primaryGenre,
    blueprint.protagonistName,
    blueprint.protagonistGender
  );

  // L4-WORD-COUNT-COMPLIANCE: deterministic final pass. Scenes are still
  // plain strings here, so buildStoryFromEpisodes will compute the correct
  // durations and timing from the adjusted text. This guarantees every
  // episode lands inside the configured band without another AI call.
  const complianceEpisodes = episodes.map((ep) => ({
    ...ep,
    scenes: ensureEpisodeWordCompliance(ep.scenes, {
      targetEpisodeWordsMin: ctx.targetEpisodeWordsMin,
      targetEpisodeWordsMax: ctx.targetEpisodeWordsMax,
      targetWordsPerScene: ctx.targetWordsPerScene,
    }),
  }));

  const pass2Ms = Number(process.hrtime.bigint() - pass2StartedAt) / 1_000_000;
  const stage5TotalMs = Number(process.hrtime.bigint() - stage5StartedAt) / 1_000_000;
  logger.info(
    {
      jobId: ctx.jobId,
      requestId: ctx.requestId,
      stage: 'episodes',
      sub: 'pass2_total',
      elapsedMs: Math.round(pass2Ms),
    },
    'STAGE5_PASS2_DONE'
  );
  ctx.episodes = complianceEpisodes;

  // Build story from episodes (sub-step of Stage 5)
  const buildStartedAt = process.hrtime.bigint();
  await progressEmit(75, 'building', 'Building story structure...');
  const story = buildStoryFromEpisodes({
    title: blueprint.title,
    genre: ctx.primaryGenre,
    ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    theme: blueprint.theme || ctx.seed || 'adventure',
    protagonistName: blueprint.protagonistName,
    protagonistAge: blueprint.protagonistAge,
    // M31: Pass protagonistGender through so the protagonist Character
    // gets the matching gender field on the persisted row. The
    // character-bible's gender overrides this when both are set
    // (bible is the AI-resolved value from Stage 3).
    ...(blueprint.protagonistGender ? { protagonistGender: blueprint.protagonistGender } : {}),
    episodes,
    characterBible,
    worldBible,
  });
  // Enforce strict 50-60s episode duration. The scene-duration clamp
  // (10-12s per scene) should already land 5 scenes in this range, but
  // clamp again at the episode level as a safety net against edge cases
  // where breath-buffer rounding pushes a scene past its clamp.
  for (const ep of story.episodes) {
    if (ep.duration < 50) ep.duration = 50;
    if (ep.duration > 60) ep.duration = 60;
    // Recalculate scene durations proportionally so the sum equals ep.duration.
    const totalSceneDuration = ep.scenes.reduce((sum, s) => sum + s.duration, 0);
    if (totalSceneDuration !== ep.duration && totalSceneDuration > 0) {
      const ratio = ep.duration / totalSceneDuration;
      for (const sc of ep.scenes) {
        sc.duration = Math.max(10, Math.min(12, Math.round(sc.duration * ratio)));
      }
    }
  }
  const buildMs = Number(process.hrtime.bigint() - buildStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', sub: 'build', elapsedMs: Math.round(buildMs) },
    'STAGE5_BUILD_DONE'
  );
  // ARCH-003: Save candidate BEFORE marking stage done, so that if the lock expires
  // and the job restarts, loadCandidate can find a valid checkpoint and the pipeline
  // resumes correctly rather than crashing on undefined story.
  const saveStartedAt = process.hrtime.bigint();
  await saveCandidate(story);
  const saveMs = Number(process.hrtime.bigint() - saveStartedAt) / 1_000_000;
  ctx.story = story;
  await markStageDone('episodes');
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', sub: 'save_candidate', elapsedMs: Math.round(saveMs) },
    'STAGE5_SAVE_CANDIDATE_DONE'
  );
  logger.info(
    {
      jobId: ctx.jobId,
      requestId: ctx.requestId,
      stage: 'episodes',
      sub: 'stage5_total',
      elapsedMs: Math.round(stage5TotalMs),
    },
    'STAGE5_TOTAL_DONE'
  );
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'episodes', elapsedMs: Math.round(stage5TotalMs), episodeCount: ctx.episodesPerStory },
    'STAGE_COMPLETED'
  );
}
