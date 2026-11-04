/**
 * Phase 2 / Fix #21: pipeline orchestrator.
 *
 * The orchestrator is the only place that owns the per-process mutable state
 * (Redis checkpoint keys, candidate JSON). The 10 stage modules are pure-ish
 * `(ctx, helpers) => Promise<void>` units that read/mutate the shared
 * `StageContext`. This file owns:
 *
 *   1. The Redis-backed checkpoint helpers (isStageDone / markStageDone).
 *   2. The candidate persistence helpers (loadCandidate / saveCandidate).
 *   3. The interim-candidate save (REL-005 — so a mid-stage-5 stall can be
 *      recovered on the next attempt without crashing on undefined fields).
 *   4. The stage-done pre-load (ARCH-004 — so stages 2-4 don't crash on
 *      `ctx.blueprint!.title` when the stage-done flag is set but the
 *      candidate was evicted).
 *   5. The stage sequence itself (1, 2, [3 || 4], 5, 7, 8, 9, 10, 11).
 *   6. The persist step (createStory + background-job enqueue).
 */

import { z } from 'zod';
import { getSharedRedis } from '../../../lib/shared-redis.js';
import { createStory } from '../../../database/prisma-storage.js';
import { addBackgroundSeoJob, addBackgroundEmbeddingJob } from '../../index.js';
import type { CharacterBible } from '../../../services/character-bible.js';
import type { WorldBible } from '../../../services/world-bible.js';
import type { Genre, Story } from '../../../services/types.js';
import type { GeneratedEpisode, StoryBlueprint } from '../../../lib/episode-generator.js';
import { logger } from '../../../services/logger.js';
import {
  episodesPerStory,
  scenesPerEpisode,
  targetWordsPerScene,
  targetEpisodeWordsMin,
  targetEpisodeWordsMax,
  sceneDurationMinSeconds,
  sceneDurationMaxSeconds,
  speakingWpm,
  targetEpisodeSeconds,
} from '../../../lib/timing.js';
import { stage1Uniqueness } from './stages/stage1-uniqueness.js';
import { stage2Blueprint } from './stages/stage2-blueprint.js';
import { stage3CharacterBible } from './stages/stage3-character-bible.js';
import { stage4WorldBible } from './stages/stage4-world-bible.js';
import { stage5Episodes } from './stages/stage5-episodes.js';
import { stage7Humanization } from './stages/stage7-humanization.js';
import { stage8Quality } from './stages/stage8-quality.js';
import { stage9Seo } from './stages/stage9-seo.js';
import { stage10CopyrightSweep } from './stages/stage10-copyright-sweep.js';
import { stage11Embedding } from './stages/stage11-embedding.js';
import type {
  GenerationCoreContext,
  StageContext,
  StageHelpers,
} from './types.js';

const STAGE_TTL_SECONDS = 7200; // 2h
const CANDIDATE_TTL_SECONDS = 14400; // 4h — must be >= STAGE_TTL_SECONDS

/**
 * MEDIUM #38: Minimum runtime shape for a Story checkpoint loaded from Redis.
 * The full Prisma `Story` type is large, so this schema validates the fields
 * required for safe rehydration and allows everything else through.
 */
const storyCandidateSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1),
    genre: z.string().min(1),
    status: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    characters: z.array(z.object({ role: z.string(), name: z.string() }).passthrough()).default([]),
    environments: z.array(z.record(z.unknown())).default([]),
    episodes: z.array(z.record(z.unknown())).default([]),
    metadata: z.record(z.unknown()).default({}),
  })
  .passthrough();

/**
 * REGEN-FAST: Convert a previously-persisted Story into the StoryCheckpoint
 * sidecar shape the pre-load block expects (protagonistName, protagonistAge,
 * setting, worldBible). The Story DB record only stores the protagonist
 * character + environments + episodes; the world bible's `antagonist` /
 * `supporting` / `environment` fields are reconstructed from rows that
 * already exist (`role='antagonist'`, `role='supporting'`, the first
 * Environment row, respectively). If the Story lacks the data needed to
 * build any of these, the function throws so the orchestrator's
 * try/catch can fall back to running stages 1-4 normally — a partial
 * preloaded story MUST NOT silently produce an incomplete candidate.
 *
 * Why we don't just store the world bible on the Story row: keeping the
 * source of truth in the character/environment tables means a single edit
 * to a character (e.g., renaming) is reflected in regeneration without a
 * second cache to keep in sync. The trade-off is one mapping step at
 * regeneration time, which is a pure function over already-loaded rows.
 */
export function buildPreloadedStoryCheckpoint(story: Story): StoryCheckpoint {
  if (!story.id || !story.title || !story.genre) {
    throw new Error('preloadedStory missing required fields (id, title, genre)');
  }
  if (!Array.isArray(story.characters) || story.characters.length === 0) {
    throw new Error('preloadedStory has no characters — cannot rebuild stage 3');
  }
  const protagonist = story.characters.find((c) => c.role === 'protagonist');
  if (!protagonist) {
    throw new Error('preloadedStory has no protagonist — cannot rebuild stage 3');
  }
  if (!Array.isArray(story.environments) || story.environments.length === 0) {
    throw new Error('preloadedStory has no environments — cannot rebuild stage 4');
  }

  const antagonist = story.characters.find((c) => c.role === 'antagonist');
  const supporting = story.characters.find((c) => c.role === 'supporting');
  const primaryEnvironment = story.environments[0]!;

  // Reconstruct the WorldBible shape (antagonist + supporting + environments).
  // L4-ENV-MULTI: persist ALL environments the story has, not just the
  // primary one. The first entry in the array is still the primary
  // setting (same as before), but downstream code (e.g. the image-prompt
  // stage) can now reference secondary environments for scenes that
  // take place in distinct locations.
  //
  // If the source story has no antagonist/supporting characters (e.g., a
  // short slice), fall back to the protagonist as both roles — this is
  // the same fallback the world-bible stage uses when the model returns
  // an incomplete shape, so behaviour is consistent.
  const wbAntagonist = antagonist ?? protagonist;
  const wbSupporting = supporting ?? protagonist;
  const worldBible: NonNullable<StoryCheckpoint['worldBible']> = {
    antagonist: {
      name: wbAntagonist.name,
      description: wbAntagonist.description,
      appearance: wbAntagonist.appearance,
      personality: wbAntagonist.personality,
      role: 'antagonist',
      ...(wbAntagonist.gender !== undefined ? { gender: wbAntagonist.gender } : {}),
      ...(antagonist?.arc ? { arc: antagonist.arc } : {}),
    },
    supporting: {
      name: wbSupporting.name,
      description: wbSupporting.description,
      appearance: wbSupporting.appearance,
      personality: wbSupporting.personality,
      role: 'supporting',
      ...(wbSupporting.gender !== undefined ? { gender: wbSupporting.gender } : {}),
      ...(supporting?.arc ? { arc: supporting.arc } : {}),
    },
    environments: story.environments.map((e) => ({
      name: e.name,
      description: e.description,
      type: e.type,
      timeOfDay: e.timeOfDay,
      weather: e.weather,
      mood: e.mood,
      keyFeatures: e.keyFeatures,
      colorPalette: e.colorPalette,
      lighting: e.lighting,
    })),
    environment: {
      name: primaryEnvironment.name,
      description: primaryEnvironment.description,
      type: primaryEnvironment.type,
      timeOfDay: primaryEnvironment.timeOfDay,
      weather: primaryEnvironment.weather,
      mood: primaryEnvironment.mood,
      keyFeatures: primaryEnvironment.keyFeatures,
      colorPalette: primaryEnvironment.colorPalette,
      lighting: primaryEnvironment.lighting,
    },
  };

  return {
    ...story,
    protagonistName: protagonist.name,
    // protagonistAge is not persisted; default to "Unknown" (same fallback
    // the blueprint stage uses on rehydration at stage2-blueprint.ts:47).
    protagonistAge: 'Unknown',
    setting: primaryEnvironment.name,
    worldBible,
  };
}

type StoryCheckpoint = Story & {
  protagonistName?: string;
  protagonistAge?: string;
  setting?: string;
  worldBible?: StageContext['worldBible'];
  // M15: Store avoidanceConstraints in the candidate JSON so they can be
  // restored on resume. Previously these were only in ctx (in-memory) and
  // were lost on stall/crash, defeating the uniqueness analysis on resume.
  avoidanceConstraints?: string[];
  avoidCharacterNames?: string[];
};

export interface RunGenerationResult {
  story: Story;
  saved: boolean;
}

/**
 * Run all stages in sequence. Throws `QualityError` (re-thrown by caller) on
 * quality failure so the retry loop in `runStoryPipeline` can decide whether
 * to retry. Non-quality errors propagate immediately.
 */
export async function runGenerationCore(
  ctx: GenerationCoreContext
): Promise<RunGenerationResult> {
  const redis = getSharedRedis();

  // H7: Attempt-fenced checkpoint keys. A BullMQ retry (attempt > 0) never
  // reads checkpoints written by an orphaned previous attempt that is still
  // running after the pipeline watchdog fired — preventing the retry from
  // skipping stage 5 with the orphan's stale candidate.
  const ckpt = (key: string): string =>
    `job:${ctx.jobId}${ctx.attempt ? `:attempt:${ctx.attempt}` : ''}:${key}`;

  async function isStageDone(stageName: string): Promise<boolean> {
    const val = await redis.get(ckpt(`stage:${stageName}:done`));
    return val === '1';
  }

  async function markStageDone(stageName: string): Promise<void> {
    await redis.set(ckpt(`stage:${stageName}:done`), '1', 'EX', STAGE_TTL_SECONDS);
  }

  async function loadCandidate(): Promise<Story | null> {
    const raw = await redis.get(ckpt('candidate:v1'));
    if (!raw) {
      // CRITICAL #5: If stage-done flags exist but the candidate JSON has been
      // evicted, we cannot safely rehydrate with Unknown defaults — downstream
      // stages would crash on undefined blueprint/character/world fields. In
      // E2E/test mode (and any time the candidate TTL genuinely expired), the
      // safest recovery is to reset the stage-done flags and re-run the pipeline
      // from scratch rather than permanently failing the job.
      const [uniquenessDone, blueprintDone] = await Promise.all([
        redis.get(ckpt('stage:uniqueness:done')),
        redis.get(ckpt('stage:blueprint:done')),
      ]);
      if (uniquenessDone === '1' || blueprintDone === '1') {
        logger.warn(
          { jobId: ctx.jobId, requestId: ctx.requestId },
          'Pipeline candidate missing but stage-done flags exist — resetting flags and re-running from scratch'
        );
        await redis.del(
          ckpt('stage:uniqueness:done'),
          ckpt('stage:blueprint:done'),
          ckpt('stage:character_bible:done'),
          ckpt('stage:world_bible:done'),
          // M5: 'episodes' sets a done flag too (stage5-episodes.ts). Omitting it
          // here left a stale episodes checkpoint flag after a from-scratch
          // reset, so stage 5 skipped and replayed the old episodes instead of
          // regenerating them.
          ckpt('stage:episodes:done')
        );
      }
      return null;
    }

    // MEDIUM #38: validate the checkpoint JSON instead of casting it. A
    // partial/corrupted checkpoint must fail the job rather than silently
    // producing stories with Unknown names or empty bibles.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Pipeline candidate JSON parse failed for job ${ctx.jobId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const validated = storyCandidateSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Pipeline candidate validation failed for job ${ctx.jobId}: ${validated.error.message}`
      );
    }
    return validated.data as unknown as Story;
  }

  async function saveCandidate(story: Story): Promise<void> {
    await redis.set(ckpt('candidate:v1'), JSON.stringify(story), 'EX', CANDIDATE_TTL_SECONDS);
  }

  /**
   * Build and persist a partial Story checkpoint as soon as stages 1–4 are
   * done. Stage 5 is the long-running, stall-prone phase. Saving here means
   * that if a worker crash / lock loss happens during stage 5, the next
   * attempt can fully restore blueprint + character bible + world bible and
   * resume from the beginning of stage 5 without crashing on undefined
   * fields. Without this, a re-queued job sees stage-done flags for 1–4 but
   * no candidate, and the skip path in stages 2/3/4 leaves ctx.blueprint
   * undefined — leading to `Cannot read properties of undefined (reading
   * 'title')` on the first read in stage 3.
   */
  async function saveInterimCandidate(): Promise<void> {
    if (!stageCtx.blueprint) {
      // Stages 1-4 didn't actually run (e.g. preloaded was full and the
      // context came from the preloaded block). Nothing new to save.
      return;
    }
    const existing = await loadCandidate();
    // The interim candidate embeds the world bible and the blueprint fields
    // (protagonistName / protagonistAge / setting) as a sidecar under
    // `metadata` so the preloaded block on resume can rehydrate everything.
    // We do not rely on the Story type's strict shape for these sidecar
    // fields — the preloaded block reads them via `(candidate as any)`.
    const interim: StoryCheckpoint = {
      ...(existing ?? ({} as Story)),
      id: existing?.id ?? ctx.jobId,
      title: stageCtx.blueprint.title,
      theme: stageCtx.blueprint.theme,
      status: 'generating',
      ...(ctx.seed != null || existing?.seed != null ? { seed: ctx.seed ?? existing?.seed! } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      genre: ctx.primaryGenre as Genre,
      characters: stageCtx.characterBible
        ? [
            {
              id: 'interim-protagonist',
              name: stageCtx.blueprint.protagonistName,
              role: 'protagonist' as const,
              description: '',
              appearance: '',
              personality: '',
              facialFeatures: stageCtx.characterBible.facialFeatures,
              clothing: stageCtx.characterBible.clothing,
              speechPatterns: stageCtx.characterBible.speechPatterns,
              emotions: stageCtx.characterBible.emotions,
              relationships: stageCtx.characterBible.relationships,
              catchphrases: stageCtx.characterBible.catchphrases,
              physicalMannerisms: stageCtx.characterBible.physicalMannerisms,
              gender: stageCtx.characterBible.gender ?? 'neutral',
            },
            // MEDIUM #39: Save ALL characters (not just protagonist) so they
            // survive resume. Without this, antagonist/supporting characters
            // are lost after a stall, and the world bible stage (4) cannot
            // rebuild the antagonist/supporting entries from the checkpoint.
            ...(existing?.characters?.filter((c) => c.role !== 'protagonist') ?? []),
          ]
        : existing?.characters ?? [],
      environments: existing?.environments ?? [],
      episodes: existing?.episodes ?? [],
      metadata: existing?.metadata ?? ({} as Story['metadata']),
    };
    // Attach the sidecar blueprint + world bible as a JSON-encoded string
    // inside metadata — keeps it within the Story contract.
    interim.protagonistName = stageCtx.blueprint.protagonistName;
    interim.protagonistAge = stageCtx.blueprint.protagonistAge;
    interim.setting = stageCtx.blueprint.setting;
    if (stageCtx.worldBible) {
      interim.worldBible = stageCtx.worldBible;
    }
    // M15: Persist avoidanceConstraints so they survive resume after stall.
    if (stageCtx.avoidanceConstraints) {
      interim.avoidanceConstraints = stageCtx.avoidanceConstraints;
    }
    if (stageCtx.avoidCharacterNames) {
      interim.avoidCharacterNames = stageCtx.avoidCharacterNames;
    }
    await saveCandidate(interim);
  }

  const helpers: StageHelpers = {
    redis,
    progressEmit: ctx.progressEmit,
    isStageDone,
    markStageDone,
    loadCandidate,
    saveCandidate,
  };

  // Stage 0 context init
  await ctx.progressEmit(3, 'init', 'Initializing story generation...');

      // Build shared stage context from GenerationCoreContext
      const stageCtx: StageContext = {
        primaryGenre: ctx.primaryGenre,
        ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
        jobId: ctx.jobId,
        requestId: ctx.requestId,
        qualityFloor: ctx.qualityFloor,
        gradeFloor: ctx.gradeFloor,
        aiScoreLimit: ctx.aiScoreLimit,
        storyBudget: ctx.storyBudget,
        persistMode: ctx.persistMode,
        // H7: Propagate the watchdog abort signal into stages so long-running
        // stages (notably stage 5's episode/scene loops) can stop mid-stage
        // instead of running an orphaned pipeline to completion.
        ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
        // M21: Snapshot timing values at job start so concurrent jobs don't
        // race on mutable module-level exports in timing.ts.
        episodesPerStory,
        scenesPerEpisode,
        targetWordsPerScene,
        targetEpisodeWordsMin,
        targetEpisodeWordsMax,
        sceneDurationMinSeconds,
        sceneDurationMaxSeconds,
        speakingWpm,
        targetEpisodeSeconds,
      };

  // REGEN-FAST: When the caller passes a preloadedStory, seed the candidate
  // JSON and mark stages 1-4 as done BEFORE running the stage sequence.
  // Each of those stages has an `isStageDone` early-return path that
  // rehydrates stageCtx from the candidate. As a result, regeneration
  // re-uses the previous run's blueprint, character bible, and world bible
  // and only re-rolls episodes (stage 5) and downstream stages 7-11.
  //
  // The preloadedStory is converted to a StoryCheckpoint (the sidecar
  // shape read by the pre-load block below): protagonist name/age/setting
  // are derived from the protagonist character + first environment, and
  // worldBible is reconstructed from the antagonist/supporting characters
  // and primary environment. If any of these are missing, the orchestrator
  // falls back to running stages 1-4 normally so a partial preloaded
  // story can never block regeneration.
  //
  // Stage names use UNDERSCORES, matching the actual `markStageDone` call
  // sites in stages/stage1..5.ts. Using hyphens (e.g. 'character-bible')
  // would silently fail the `isStageDone` check and the stage would still
  // run, defeating the whole point of the pre-load.
  if (ctx.preloadedStory) {
    try {
      const checkpoint = buildPreloadedStoryCheckpoint(ctx.preloadedStory);
      await saveCandidate(checkpoint);
      await Promise.all([
        markStageDone('uniqueness'),
        markStageDone('blueprint'),
        markStageDone('character_bible'),
        markStageDone('world_bible'),
      ]);
      logger.info(
        { jobId: ctx.jobId, requestId: ctx.requestId, storyId: ctx.preloadedStory.id },
        'REGEN-FAST: preloadedStory — skipping stages 1-4'
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { jobId: ctx.jobId, requestId: ctx.requestId, err: errMsg },
        'REGEN-FAST: preloadedStory build failed — falling back to running stages 1-4'
      );
    }
  }

  // ARCH-004: Pre-load any saved candidate into stageCtx so that skip logic
  // in stages 2-4 can access ctx.blueprint/characterBible/worldBible without
  // crashing when those stages detect their checkpoints are already done.
  const preloaded = await loadCandidate();
  if (preloaded) {
    const checkpoint = preloaded as StoryCheckpoint;
    stageCtx.blueprint = {
      title: preloaded.title,
      protagonistName: checkpoint.protagonistName ?? 'Unknown',
      protagonistAge: checkpoint.protagonistAge ?? 'Unknown',
      setting: checkpoint.setting ?? 'Unknown',
      theme: preloaded.theme ?? preloaded.seed ?? 'Unknown',
      logline: preloaded.seed ?? 'Unknown',
    };
    if (preloaded.characters?.length) {
      const protagonist = preloaded.characters.find((c) => c.role === 'protagonist');
      if (protagonist) {
        stageCtx.characterBible = {
          speechPatterns: protagonist.speechPatterns || 'Natural, authentic',
          clothing: protagonist.clothing || 'Genre-appropriate',
          facialFeatures: protagonist.facialFeatures || 'Expressive',
          emotions: protagonist.emotions || ['curiosity', 'determination'],
          relationships: protagonist.relationships || {},
          catchphrases: protagonist.catchphrases || [],
          physicalMannerisms: protagonist.physicalMannerisms || 'Natural gestures',
          gender: (protagonist.gender === 'male' || protagonist.gender === 'female' || protagonist.gender === 'neutral')
            ? protagonist.gender
            : 'neutral',
        } as CharacterBible;
      }
    }
    if (checkpoint.worldBible) {
      stageCtx.worldBible = checkpoint.worldBible;
    }
    if (preloaded.episodes?.length) {
      stageCtx.episodes = preloaded.episodes as unknown as GeneratedEpisode[];
      stageCtx.story = preloaded;
    }
  }

  // H4: Helper to check the abort signal between stages. When the pipeline
  // timeout fires (watchdog), the AbortController aborts so the orphaned
  // runGenerationCore stops making AI calls instead of running indefinitely.
  function checkAborted(): void {
    if (ctx.abortSignal?.aborted) {
      throw new Error(`Pipeline aborted (job ${ctx.jobId}) — watchdog timeout or cancellation`);
    }
  }

  // Run stages 1-11
  checkAborted();
  await stage1Uniqueness(stageCtx, helpers);
  checkAborted();
  await stage2Blueprint(stageCtx, helpers);
  checkAborted();
  // Stage3 + Stage4 are independent (both only need ctx.blueprint) — run concurrently
  // M18: Use Promise.allSettled instead of Promise.all so that if one stage
  // throws, the other's result is not lost and saveInterimCandidate still runs.
  // With Promise.all, a single rejection skipped saveInterimCandidate, causing
  // the successful stage's data to be lost on resume (replaced with defaults).
  const stageResults = await Promise.allSettled([
    stage3CharacterBible(stageCtx, helpers),
    stage4WorldBible(stageCtx, helpers),
  ]);
  // If either stage rejected, re-throw the first rejection so the pipeline
  // error handling kicks in — but only AFTER both stages have settled.
  for (const r of stageResults) {
    if (r.status === 'rejected') throw r.reason;
  }
  checkAborted();
  // REL-005: Save an interim candidate as soon as we have blueprint + bibles
  // so a mid-stage-5 stall (worker crash, lock loss, redeploy) can be
  // recovered on the next attempt. Without this, the next attempt would see
  // stage-done flags for 1-4 but no candidate, and crash on the first read
  // of ctx.blueprint.
  await saveInterimCandidate();
  checkAborted();
  await stage5Episodes(stageCtx, helpers);
  checkAborted();
  await stage7Humanization(stageCtx, helpers);
  checkAborted();
  // Stages 8-11 run sequentially to avoid blocking on concurrent watchdogs.
  await stage8Quality(stageCtx, helpers);
  checkAborted();
  await stage9Seo(stageCtx, helpers);
  checkAborted();
  await stage10CopyrightSweep(stageCtx, helpers);
  checkAborted();
  await stage11Embedding(stageCtx, helpers);

  // Populate back into ctx for persist stage
  // PR-001: per-statement timing to localize any post-Stage-9 stall.
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'pre_persist' },
    'PERSIST_STAGE_REACHED'
  );
  await ctx.progressEmit(96, 'persisting', 'Saving to database...');
  const story = stageCtx.story!;

  if (ctx.persistMode === 'return-candidate') {
    logger.info({ jobId: ctx.jobId, requestId: ctx.requestId }, 'persistMode=return-candidate, skipping createStory');
    // H26c: attach the owner id to the returned candidate too — the caller
    // (story-regeneration → replaceStoryAtomically) validates it with
    // isStoryInput, which requires userId. Previously the injection below
    // only ran on the createStory path, so every regeneration failed with
    // 500 "Invalid story payload" after completing the pipeline.
    const candidateWithOwner = (ctx.userId ? { ...story, userId: ctx.userId } : story) as Story;
    return { story: candidateWithOwner, saved: false };
  }

  const persistStartNs = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'persist', title: story.title, episodeCount: story.episodes.length },
    'PERSIST_CREATE_STORY_STARTED'
  );
  // Inject userId from the job data so the story is owned by the requesting user.
  // The userId is set on the story object before createStory, which connects it
  // via the StoryInput.userId field in buildStoryCreateData.
  // M32: When forceNew=true, set a unique deduplicationKey so the insert bypasses
  // the (genre, deduplicationKey) partial unique index while preserving the
  // user-visible seed.
  const deduplicationKey = ctx.forceNew
    ? `${story.seed || ''}::forceNew::${ctx.jobId}`
    : undefined;
  const storyWithOwner = {
    ...story,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(deduplicationKey !== undefined ? { deduplicationKey } : {}),
  } as Parameters<typeof createStory>[0];
  const protagonistName = stageCtx.blueprint?.protagonistName;
  const saved = await createStory(
    storyWithOwner,
    protagonistName ? { protagonistName } : {}
  );
  const persistMs = Number(process.hrtime.bigint() - persistStartNs) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'persist', elapsedMs: Math.round(persistMs), storyId: saved.id },
    'PERSIST_CREATE_STORY_COMPLETED'
  );

  // Enqueue background SEO and embedding jobs (fire-and-forget, don't block completion)
  const conceptText = [
    story.title,
    story.theme || '',
    story.seed || '',
    story.episodes[0]?.synopsis || '',
    story.episodes[1]?.synopsis || '',
  ]
    .filter(Boolean)
    .join(' | ');

  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'background_enqueue', storyId: saved.id },
    'BACKGROUND_ENQUEUE_STARTED'
  );
  try {
    // M19: Only enqueue background embedding if stage 11 didn't produce one.
    // Stage 11 computes the embedding and sets story.embedding. Enqueuing a
    // second background job that recomputes the same embedding wastes API
    // quota and adds latency. Only use the background job as a fallback when
    // stage 11 produced no embedding (null/empty).
    const backgroundJobs: Promise<unknown>[] = [];
    // M6: Stage 9 already generated and persisted YouTube SEO (real AI output,
    // or a default fallback on failure) via createStory. Re-enqueueing a
    // background job that calls generateYouTubeSEO again doubled the AI cost of
    // every story. Only use the background job as a fallback when stage 9
    // produced no SEO at all.
    if (!story.youtubeSeo) {
      backgroundJobs.push(
        addBackgroundSeoJob({
          storyId: saved.id,
          storyTitle: story.title,
          genre: stageCtx.primaryGenre,
          protagonistName: stageCtx.blueprint!.protagonistName,
          episodeHook: stageCtx.episodes?.[0]?.hook || 'Watch this story',
          episodeCount: stageCtx.episodes?.length ?? 10,
        })
      );
    }
    if (!story.embedding || story.embedding.length === 0) {
      backgroundJobs.push(
        addBackgroundEmbeddingJob({
          storyId: saved.id,
          conceptText,
        })
      );
    }
    await Promise.all(backgroundJobs);
  } catch (err) {
    logger.warn({ err }, 'Background job enqueue failed');
  }
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'background_enqueue', storyId: saved.id },
    'BACKGROUND_ENQUEUE_RETURNED'
  );

  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'finalize', storyId: saved.id },
    'PERSIST_FINALIZE_DONE'
  );
  return { story: saved, saved: true };
}

// ---------------------------------------------------------------------------
// CRIT-10: Post-generation stages helper for the refinement success path.
//
// `runStoryPipeline`'s refinement branch applies a refinement plan to a
// story candidate, re-judges it, and — when it passes — must still run
// humanization (7), SEO (9), copyright sweep (10, security-critical), and
// embedding (11) before persisting. Stage 8 is NOT included: the refined
// story has already been judged as passing quality, so re-running the
// quality gate would either succeed (no-op) or throw a QualityError that
// would loop the retry unnecessarily.
//
// `runPostStage5Stages` runs stages 7, 9, 10, 11 in order. The caller is
// responsible for catching errors (e.g., the monetization hard-reject
// from stage 10 surfaces here).
//
// `buildStageContextFromStory` constructs a minimal StageContext from a
// Story by mirroring the Redis pre-load block above — blueprint fields
// are taken from the protagonist character, characterBible is rebuilt
// from the protagonist, worldBible from the antagonist/supporting/
// environments. This is the same shape the persist path expects.
// ---------------------------------------------------------------------------

/**
 * Build a StageContext + StageHelpers pair from a Story, mirroring the
 * orchestrator's Redis pre-load block (lines ~427-462 of runGenerationCore).
 *
 * Used by the refinement success path so stages 7, 9, 10, 11 can run on
 * the refined Story before persistence, instead of short-circuiting to
 * createStory with no post-stage-5 processing.
 */
export function buildStageContextFromStory(
  story: Story,
  base: {
    jobId: string;
    requestId: string;
    primaryGenre: string;
    qualityFloor: number;
    gradeFloor: string;
    aiScoreLimit: number;
    storyBudget: number;
    persistMode: 'create' | 'return-candidate';
    seed?: string;
  }
): { ctx: StageContext; helpers: StageHelpers } {
  const protagonist = story.characters?.find((c) => c.role === 'protagonist');
  const blueprint: StoryBlueprint = {
    title: story.title,
    protagonistName: protagonist?.name ?? 'Unknown',
    protagonistAge: 'Unknown',
    ...(protagonist?.gender === 'male' || protagonist?.gender === 'female' || protagonist?.gender === 'neutral'
      ? { protagonistGender: protagonist.gender }
      : {}),
    setting: story.environments?.[0]?.name ?? 'Unknown',
    theme: story.theme ?? story.seed ?? 'Unknown',
    logline: story.seed ?? 'Unknown',
  };

  let characterBible: CharacterBible | undefined;
  if (protagonist) {
    characterBible = {
      speechPatterns: protagonist.speechPatterns || 'Natural, authentic',
      clothing: protagonist.clothing || 'Genre-appropriate clothing',
      facialFeatures: protagonist.facialFeatures || 'Expressive features',
      emotions: protagonist.emotions?.length ? protagonist.emotions : ['curiosity', 'determination'],
      relationships: protagonist.relationships || {},
      catchphrases: protagonist.catchphrases || [],
      physicalMannerisms: protagonist.physicalMannerisms || 'Natural gestures',
      gender: (protagonist.gender === 'male' || protagonist.gender === 'female' || protagonist.gender === 'neutral')
        ? protagonist.gender
        : 'neutral',
    };
  }

  // Reconstruct a WorldBible from antagonist/supporting characters + the
  // Story's environments, mirroring buildPreloadedStoryCheckpoint. Stages
  // 7's pronoun fix only needs the names; full WorldBible is for stage 7's
  // `ctx.worldBible` reference (used by the cross-scene diversity pass).
  const antagonist = story.characters?.find((c) => c.role === 'antagonist') ?? protagonist;
  const supporting = story.characters?.find((c) => c.role === 'supporting') ?? protagonist;
  const worldBible: WorldBible | undefined = story.environments?.length
    ? {
        antagonist: {
          name: antagonist?.name ?? 'Unknown Antagonist',
          description: antagonist?.description ?? '',
          appearance: antagonist?.appearance ?? '',
          personality: antagonist?.personality ?? '',
          role: 'antagonist',
        },
        supporting: {
          name: supporting?.name ?? 'Unknown Supporting',
          description: supporting?.description ?? '',
          appearance: supporting?.appearance ?? '',
          personality: supporting?.personality ?? '',
          role: 'supporting',
        },
        environments: story.environments.map((e) => ({
          name: e.name,
          description: e.description,
          type: e.type,
          timeOfDay: e.timeOfDay,
          weather: e.weather,
          mood: e.mood,
          keyFeatures: e.keyFeatures,
          colorPalette: e.colorPalette,
          lighting: e.lighting,
        })),
        environment: {
          name: story.environments[0]!.name,
          description: story.environments[0]!.description,
          type: story.environments[0]!.type,
          timeOfDay: story.environments[0]!.timeOfDay,
          weather: story.environments[0]!.weather,
          mood: story.environments[0]!.mood,
          keyFeatures: story.environments[0]!.keyFeatures,
          colorPalette: story.environments[0]!.colorPalette,
          lighting: story.environments[0]!.lighting,
        },
      }
    : undefined;

  const ctx: StageContext = {
    primaryGenre: base.primaryGenre,
    ...(base.seed !== undefined ? { seed: base.seed } : {}),
    jobId: base.jobId,
    requestId: base.requestId,
    qualityFloor: base.qualityFloor,
    gradeFloor: base.gradeFloor,
    aiScoreLimit: base.aiScoreLimit,
    storyBudget: base.storyBudget,
    persistMode: base.persistMode,
    episodesPerStory,
    scenesPerEpisode,
    targetWordsPerScene,
    targetEpisodeWordsMin,
    targetEpisodeWordsMax,
    sceneDurationMinSeconds,
    sceneDurationMaxSeconds,
    speakingWpm,
    targetEpisodeSeconds,
    blueprint,
    ...(characterBible !== undefined ? { characterBible } : {}),
    ...(worldBible ? { worldBible } : {}),
    episodes: story.episodes as unknown as GeneratedEpisode[],
    story,
  };

  // Stage 7 uses progressEmit; stage 9 uses progressEmit; stage 11 uses
  // progressEmit. Stage 10 uses no helpers. isStageDone / markStageDone /
  // loadCandidate / saveCandidate are NOT used by stages 7, 9, 10, 11
  // (only stages 1-5 use the checkpoint helpers), so stubs are safe.
  const noopEmit: StageHelpers['progressEmit'] = async () => undefined;
  const helpers: StageHelpers = {
    redis: getSharedRedis(),
    progressEmit: noopEmit,
    isStageDone: async () => false,
    markStageDone: async () => undefined,
    loadCandidate: async () => null,
    saveCandidate: async () => undefined,
  };

  return { ctx, helpers };
}

/**
 * Run stages 7 (humanization), 9 (SEO), 10 (copyright sweep), and
 * 11 (embedding) in sequence on the supplied StageContext. Used by the
 * refinement success path in runStoryPipeline so refined stories go
 * through the same post-stage-5 processing as the normal pipeline.
 *
 * Stage 8 (quality gate) is intentionally NOT included — the caller has
 * already judged the refined story as passing quality.
 *
 * Aborts on `abortSignal?.aborted` between stages to honour the watchdog.
 */
export async function runPostStage5Stages(
  ctx: StageContext,
  helpers: StageHelpers,
  abortSignal?: AbortSignal
): Promise<void> {
  function checkAborted(): void {
    if (abortSignal?.aborted) {
      throw new Error(`Pipeline aborted (job ${ctx.jobId}) — watchdog timeout or cancellation`);
    }
  }
  await stage7Humanization(ctx, helpers);
  checkAborted();
  await stage9Seo(ctx, helpers);
  checkAborted();
  await stage10CopyrightSweep(ctx, helpers);
  checkAborted();
  await stage11Embedding(ctx, helpers);
}
