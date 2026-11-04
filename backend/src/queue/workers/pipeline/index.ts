/**
 * Phase 2 / Fix #21: public pipeline API.
 *
 * `runStoryPipeline` is the synchronous entry point used by the BullMQ
 * worker (via `processStoryJob`) AND by the regenerate endpoint when an
 * atomic replace-in-place is required. It is the only public surface of
 * the pipeline; everything else is an implementation detail.
 *
 * Re-exports: `QualityError` and `__resetDeathLoopGuard` are exported
 * here so the test file in `../story.worker.test.ts` and the worker
 * module can re-export them.
 */

import { checkTokenBudget } from '../../../services/token-budget.js';
import { getSystemSetting, getSystemSettingInt } from '../../../services/settings.js';
import { loadTimingOverrides } from '../../../lib/timing.js';
import { logger } from '../../../services/logger.js';
import { deathLoopGuard, __resetDeathLoopGuard } from './death-loop-guard.js';
import { runGenerationCore, buildStageContextFromStory, runPostStage5Stages, type RunGenerationResult } from './orchestrator.js';
import type { Story } from '../../../services/types.js';
import { QualityError } from './quality-error.js';
import { runWithAIPipelineContext } from '../../../lib/ai-client.js';
import { createWatchdogAbortController } from '../../../lib/watchdog.js';
import { evaluateSeed, enrichSeed } from '../../../lib/seed-evaluator.js';
import { judgeStoryQuality } from '../../../services/quality-judge.js';
import { generateRefinementPlan, applyRefinementPlan } from '../../../lib/quality-refiner.js';
import { createStory } from '../../../database/prisma-storage.js';
import { addBackgroundSeoJob, addBackgroundEmbeddingJob } from '../../../queue/index.js';
import { getSharedRedis } from '../../../lib/shared-redis.js';
import { e2eTestBypassEnabled, cannedModeEnabled, getStoryTokenBudgetEstimate } from '../../../config/env.js';

/**
 * M32: Build a unique deduplicationKey for forceNew=true inserts.
 * Appends the unique jobId to the seed so the (genre, deduplicationKey)
 * partial unique index allows intentional duplicates while still blocking
 * accidental exact duplicates.
 */
function buildForceNewDedupKey(seed: string, jobId: string): string {
  return `${seed || 'no-seed'}::forceNew::${jobId}`;
}


// Lazy getter so PIPELINE_TIMEOUT_MS is read after validateAndLoadEnv()
// and loadEnvFiles() have completed. Defaults to 45 minutes.
function getPipelineTimeoutMs(): number {
  return parseInt(process.env.PIPELINE_TIMEOUT_MS ?? '2700000', 10);
}

export interface RunGenerationOptions {
  genre: string[];
  seed?: string;
  jobId: string;
  requestId: string;
  emit?: (
    type: 'progress' | 'complete' | 'error',
    progress: number,
    stage?: string,
    message?: string,
    data?: unknown
  ) => Promise<void>;
  persistMode?: 'create' | 'return-candidate';
  userId?: string;
  /** M32: When true, the story is persisted with a unique deduplicationKey so
   * an intentional duplicate seed can bypass the (genre, deduplicationKey)
   * partial unique index. */
  forceNew?: boolean;
  // M28: When true, the pipeline accepts the story regardless of quality
  // score and grade. Used for automatic DLQ retries — a story that was
  // rejected for being slightly below the grade floor gets a second chance
  // with relaxed thresholds rather than being permanently stuck in the DLQ.
  // Real AI output (Kimi K3) produces stories in a narrower quality
  // band than the floor assumes; this prevents permanent loss.
  retryFromDlq?: boolean;
  /** H7: BullMQ attempt number (attemptsMade). Checkpoint keys are namespaced
   * with it so a BullMQ retry never reads checkpoints written by an orphaned
   * previous attempt that is still running after the pipeline watchdog fired. */
  attempt?: number;
  /** REGEN-FAST: When set, the orchestrator pre-seeds the candidate JSON
   * and marks stages uniqueness / blueprint / character-bible / world-bible
   * as done so regeneration re-uses the previous run's bibles and only
   * re-rolls episodes + downstream stages. Without this, regeneration
   * re-issues 3 bible-stage + 80+ episode-stage AI calls and takes ~3-4
   * minutes; with it, the bible-stage calls are skipped and the runtime
   * drops to ~1 minute. See
   * buildPreloadedStoryCheckpoint in the orchestrator for the shape. */
  preloadedStory?: Story | null;
  /** M28: Per-job token-budget reservation estimate. If omitted, the pipeline
   * uses the AI_STORY_TOKEN_BUDGET_ESTIMATE env default. A non-zero value
   * triggers an atomic reservation at the Stage-0 gate so concurrent jobs
   * cannot overshoot the budget. */
  tokenBudgetEstimate?: number;
}

export type { Story, RunGenerationResult };
export { QualityError, __resetDeathLoopGuard };

/**
 * Run the full story-generation pipeline and return the persisted Story.
 *
 * Used by the BullMQ worker (via processStoryJob) and by the synchronous
 * regenerate endpoint when an atomic replace-in-place is required.
 *
 * - emit: optional progress emitter; ignored if undefined (sync caller).
 * - persistMode 'create' calls createStory; 'return-candidate' returns the
 *   candidate Story object WITHOUT persisting (the caller persists atomically).
 * - retryFromDlq accepts the story regardless of quality score/grade.
 */
export async function runStoryPipeline(
  options: RunGenerationOptions
): Promise<RunGenerationResult> {
  const { genre, jobId, requestId, emit, persistMode = 'create', userId, retryFromDlq = false, forceNew = false, tokenBudgetEstimate } = options;
  let { seed, preloadedStory } = options;
  const primaryGenre = genre[0]!;

  const noopEmit: NonNullable<RunGenerationOptions['emit']> = async () => undefined;
  const safeEmit = emit ?? noopEmit;

  // BIZ-002: Load timing overrides from DB (falls back to code defaults if unreachable)
  await loadTimingOverrides().catch((err) => {
    logger.warn({ err }, 'loadTimingOverrides failed — using code defaults');
  });

  // Load pipeline thresholds from DB. Defaults match migration seed values.
  // If DB is unreachable, fall back to code defaults so the pipeline still runs.
  let [qualityFloor, gradeFloor, aiScoreLimit, storyBudget, qualityMaxRetries, seedThreshold, publishThreshold, autoRefinement] =
    await Promise.all([
      getSystemSettingInt('quality_floor', 70).catch(() => 70),
      getSystemSetting('grade_floor', 'C').catch(() => 'C'),
      getSystemSettingInt('humanization_score_limit', 80).catch(() => 80),
      getSystemSettingInt('humanization_story_budget', 50).catch(() => 50),
      getSystemSettingInt('humanization_story_quality_retries', 2).catch(() => 2),
      getSystemSettingInt('seed_quality_threshold', 50).catch(() => 50),
      getSystemSettingInt('publish_threshold', 70).catch(() => 70),
      getSystemSetting('auto_refinement_enabled', 'true').catch(() => 'true'),
    ]);

  // REL-019: Death-loop auto-mitigation. If we're in canned test mode but the
  // configured quality floor / grade floor are at production-realistic values
  // (e.g., 80/B), the canned story (~70/C) will never pass quality and the job
  // will retry forever, saturating the event loop. We log a loud,
  // once-per-process warning AND override the thresholds for this run only —
  // the DB values are NOT changed, so production deploys are safe.
  //
  // SECURITY: Only allow this override in test/E2E environments. A leaked
  // STORY_TEST_MODE=canned in production must not silently disable quality gates.
  // Both helpers are gated on NODE_ENV !== production (see config/env.ts).
  const isTestEnv = process.env.NODE_ENV === 'test' || e2eTestBypassEnabled();
  if (cannedModeEnabled() && (qualityFloor > 50 || gradeFloor !== 'F' || aiScoreLimit < 999)) {
    deathLoopGuard.log();
    qualityFloor = 0;
    gradeFloor = 'F';
    aiScoreLimit = 999;
    logger.warn(
      { requestId, qualityFloor, gradeFloor, aiScoreLimit },
      'Overriding quality thresholds for canned test mode (in-memory only)'
    );
  }

  // E2E tests use seeds starting with "e2e-" — lower quality floor so that
  // live-API tests are not rejected when provider circuit breakers degrade
  // output quality. Removing this override only affects the E2E test suite.
  // SECURITY: Only apply the e2e- seed override in test/E2E environments so a
  // user cannot bypass quality gates by picking an e2e- seed in production.
  if (isTestEnv && seed?.startsWith('e2e-') && (qualityFloor > 0 || gradeFloor !== 'F')) {
    qualityFloor = 0;
    gradeFloor = 'F';
    logger.warn(
      { requestId, seed, qualityFloor, gradeFloor },
      'Overriding quality thresholds for E2E test seed (in-memory only)'
    );
  }

  // Normalize grade floor to uppercase so lowercase settings do not silently
  // disable the grade comparison (stage8-quality uses uppercase lookups).
  gradeFloor = String(gradeFloor).toUpperCase();

  // M28: DLQ retry — accept the story regardless of quality score/grade.
  // When a job is retried from the DLQ (automatic or manual admin restart),
  // the story has already been generated once. The reason it ended up in
  // the DLQ was likely a marginal quality miss (e.g., grade C when floor
  // was B). Rather than letting it stay stuck, the retry runs the full
  // pipeline again with relaxed thresholds. The story data is still real
  // (generated by the same AI provider); we just don't gate it on the
  // strict grade floor a second time. This is an in-memory override only —
  // the DB floor value is not changed.
  // M28 / HIGH #20: DLQ retry quality override. Relaxed thresholds are only
  // applied when the explicit ALLOW_DLQ_QUALITY_OVERRIDE flag is set. Without
  // the flag, DLQ retries keep the configured qualityFloor/gradeFloor so
  // substandard stories cannot bypass quality gates by accident. Canned test
  // mode and e2e seeds above keep their overrides because they are test paths.
  if (retryFromDlq && process.env.ALLOW_DLQ_QUALITY_OVERRIDE === 'true' && (qualityFloor > 0 || gradeFloor !== 'F')) {
    qualityFloor = 0;
    gradeFloor = 'F';
    logger.warn(
      { requestId, qualityFloor, gradeFloor },
      'Overriding quality thresholds for DLQ retry (in-memory only) — accepting story regardless of grade'
    );
  } else if (retryFromDlq && process.env.ALLOW_DLQ_QUALITY_OVERRIDE !== 'true') {
    logger.info(
      { requestId, qualityFloor, gradeFloor },
      'DLQ retry detected but ALLOW_DLQ_QUALITY_OVERRIDE is not set — keeping configured quality thresholds'
    );
  }

  logger.info(
    { requestId, qualityFloor, gradeFloor, aiScoreLimit, storyBudget, qualityMaxRetries, seedThreshold, publishThreshold, autoRefinement },
    'Pipeline thresholds loaded'
  );

  // QUALITY-1: Evaluate seed quality before running the expensive pipeline.
  // If the seed is weak (< seedThreshold), enrich it or reject it early.
  // This prevents weak seeds from burning 48+ API calls for a low-quality result.
  if (seed && seed.length > 3 && !seed.startsWith('e2e-')) {
    await safeEmit('progress', 1, 'seed_evaluation', 'Evaluating seed quality...');
    try {
      const seedEval = await evaluateSeed(primaryGenre, seed, seedThreshold);
      logger.info(
        { requestId, seedScore: seedEval.overallScore, isValid: seedEval.isValid },
        'Seed evaluation complete'
      );

      if (!seedEval.isValid) {
        if (autoRefinement === 'true' && seedEval.enrichmentSuggestion) {
          const enriched = await enrichSeed(primaryGenre, seed, seedEval);
          if (enriched?.enriched && enriched.enriched.length > 10) {
            // Replace the seed with the enriched version but preserve the
            // original for logging.
            seed = enriched.enriched;
            logger.info(
              { requestId, originalSeed: enriched.original, enrichedSeed: enriched.enriched, changes: enriched.changes },
              'Seed enriched by quality pipeline'
            );
            await safeEmit('progress', 2, 'seed_enriched', `Seed enriched: ${enriched.changes.join('; ')}`);
          }
        } else {
          // Seed is too weak and enrichment is disabled — reject early.
          logger.warn(
            { requestId, seedScore: seedEval.overallScore, seed: seed.slice(0, 100) },
            'Seed rejected by quality pipeline (below threshold and enrichment disabled)'
          );
          await safeEmit('error', 0, 'seed_rejected', `Seed quality score ${seedEval.overallScore} is below threshold ${seedThreshold}. Try a more specific premise.`);
          throw new Error(`Seed rejected: quality score ${seedEval.overallScore} below threshold ${seedThreshold}`);
        }
      }
    } catch (err) {
      // If seed evaluation itself fails (e.g., provider unavailable), log and
      // proceed — better to attempt generation than to block the pipeline.
      if (err instanceof Error && err.message.startsWith('Seed rejected')) throw err;
      logger.warn({ requestId, err: String(err) }, 'Seed evaluation failed — proceeding with original seed');
    }
  }

  // Pipeline-level timeout: wraps every `runGenerationCore` call (including
  // any quality retries) in a hard timeout. If a stage or AI call hangs,
  // the job is failed rather than stuck. Configurable via PIPELINE_TIMEOUT_MS.
  //
  // QUALITY-4/5/6: Controlled retry with feedback-driven refinement.
  // Instead of blind regenerations, each retry:
  //   1. Runs the deterministic LLM judge on the previous attempt's result
  //   2. Generates a targeted refinement plan based on the lowest sub-scores
  //   3. Applies only the changes needed to fix specific weaknesses
  //   4. Changes focus area each retry (never repeats the same approach)
  // This means retries converge instead of cycling through identical results.
  let lastError: Error | undefined;
  // Track the best result across attempts for the "at least return the best" guarantee.
  interface BestAttempt {
    story: Story;
    score: number;
    grade: string;
  }
  let bestAttempt: BestAttempt | null = null;
  // QUALITY-5: Track which refinement approaches have been tried so subsequent
  // retries avoid repeating the same approach.
  const triedApproaches: string[] = [];

  for (let attempt = 1; attempt <= qualityMaxRetries + 1; attempt++) {
    // Re-check token budget before each retry attempt. Each pipeline run
    // can consume significant budget; without this check, N retries could
    // burn Nx the allocated budget before the refund fires in processStoryJob.
    // M28: Reserve an estimated token budget atomically at the gate. The
    // reservation is idempotent for this jobId, so retries do not double-charge.
    // Actual usage is recorded per-call and reconciled (refund/charge delta) by
    // finalizeTokenBudget at job completion. If the reservation is disabled
    // (estimate = 0), the gate falls back to the advisory read-only check.
    const estimate = tokenBudgetEstimate ?? getStoryTokenBudgetEstimate();
    const budget = await checkTokenBudget(
      estimate > 0 ? { estimatedTotal: estimate, jobId } : undefined
    );
    if (!budget.ok) {
      const reason = budget.reason || 'Token budget exceeded';
      logger.warn({ jobId, requestId, budget, attempt }, reason);
      await safeEmit('error', 0, 'budget', reason);
      throw new Error(reason);
    }

    try {
      const result = await withWatchdogTimeout(
        (signal) => runGenerationCore({
        primaryGenre,
        // On retry 2+, pass the previous best story as preloaded so the
        // pipeline re-uses bibles and only re-runs episodes + downstream.
        ...(seed !== undefined ? { seed } : {}),
        jobId,
        requestId,
        progressEmit: async (pct, stage, msg, data) => {
          await safeEmit('progress', pct, stage, msg, data);
        },
        qualityFloor,
        gradeFloor,
        aiScoreLimit,
        storyBudget,
        persistMode,
        forceNew,
        ...(userId !== undefined ? { userId } : {}),
        ...(preloadedStory !== undefined ? { preloadedStory } : null),
        abortSignal: signal,
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
      }),
        getPipelineTimeoutMs(),
        jobId,
        seed?.startsWith('e2e-') ?? false
      );
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // H7: On a pipeline watchdog timeout, delete THIS attempt's candidate
      // and stage-done flags. The BullMQ retry (attempt+1) reads fresh fenced
      // keys anyway, but cleanup prevents an orphaned attempt's checkpoints
      // from lingering until TTL and being read by anything else.
      if (lastError.message.startsWith('Pipeline timed out')) {
        try {
          const { deleteJobCandidate } = await import('../../redis-pubsub.js');
          await deleteJobCandidate(jobId);
        } catch (cleanupErr) {
          logger.warn({ err: cleanupErr, jobId }, 'H7: timeout checkpoint cleanup failed');
        }
      }
      // REL-002: Use instanceof QualityError to distinguish from infrastructure errors.
      // Non-quality errors (Redis, circuit breaker, network) propagate immediately
      // without consuming retry budget.
      //
      // H2 ROOT-CAUSE FIX: A QualityError must NOT throw on the final attempt.
      // Previously the condition `|| attempt > qualityMaxRetries` threw on the
      // last loop iteration (attempt === qualityMaxRetries + 1), so the loop
      // NEVER completed normally and the QUALITY-6 "publish best attempt"
      // fallback below was dead code — every near-miss story failed to the DLQ
      // even when it met publish_threshold. Now a QualityError is always
      // captured into bestAttempt and the loop exhausts naturally, letting the
      // fallback publish the best attempt (or throw lastError when it is below
      // the publish threshold). Infrastructure errors still throw immediately.
      if (!(err instanceof QualityError)) throw lastError;

      // QUALITY-4/5: Feedback-driven refinement. Run the deterministic judge
      // on the story candidate (if available) and generate a targeted plan.
      let refinementInfo = '';
      let refinedApplied = false;
      if (err.storyCandidate) {
        try {
          const verdict = await judgeStoryQuality(err.storyCandidate);
          if (verdict) {
            // H16: Keep the BEST attempt, not the LAST. Unconditional
            // assignment meant a monotonically degrading retry sequence
            // (69 → 61 → 55) published the worst (last) candidate even
            // though an earlier one met the publish threshold.
            if (!bestAttempt || verdict.overallScore > bestAttempt.score) {
              bestAttempt = {
                story: err.storyCandidate,
                score: verdict.overallScore,
                grade: verdict.grade,
              };
            }

            // QUALITY-5: Generate a refinement plan that avoids previously
            // tried approaches (identified by their target areas).
            const plan = await generateRefinementPlan(
              err.storyCandidate,
              verdict,
              attempt - 1
            );
            if (plan) {
              // QUALITY-6: Never repeat the same approach.
              const isNew = !plan.targetAreas.some((area) =>
                triedApproaches.some((prev) => area.toLowerCase().includes(prev.toLowerCase()))
              );
              if (isNew) {
                triedApproaches.push(...plan.targetAreas);
                try {
                  // FIX: Apply the refinement plan to the story candidate
                  // and re-judge immediately. If the refined story now
                  // passes quality, persist it and return DIRECTLY without
                  // a full pipeline retry (which would overwrite the
                  // refined episodes by regenerating them from scratch).
                  const refined = await applyRefinementPlan(err.storyCandidate, plan);
                  const refinedVerdict = await judgeStoryQuality(refined);
                  const GRADE_NUM: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
                  const gradeOk = (GRADE_NUM[refinedVerdict?.grade ?? 'F'] ?? 0) >= (GRADE_NUM[String(gradeFloor)] ?? 0);
                  if (refinedVerdict && refinedVerdict.overallScore >= qualityFloor && gradeOk) {
                    try {
                      // CRIT-10: Run the post-stage-5 generation stages
                      // (humanization, SEO, copyright sweep, embedding) on
                      // the refined story BEFORE persisting. Refinement
                      // rewrites narration via Kimi; the fresh prose needs
                      // humanization (stage 7) so AI-pattern indicators are
                      // removed. SEO columns must be populated before the row
                      // is written (stage 9). Copyright sweep (stage 10) is
                      // security-critical and can throw a hard-reject on
                      // monetization-blocked terms — that throw surfaces here
                      // and is caught by the outer refineErr handler, which
                      // falls through to the retry path so the job does not
                      // persist a takedown-liable row.
                      const { ctx: refinedCtx, helpers: refinedHelpers } = buildStageContextFromStory(refined, {
                        jobId,
                        requestId,
                        primaryGenre,
                        qualityFloor,
                        gradeFloor,
                        aiScoreLimit,
                        storyBudget,
                        persistMode,
                        ...(seed !== undefined ? { seed } : {}),
                      });
                      await runPostStage5Stages(refinedCtx, refinedHelpers);
                      // After stages run, the refined story now has the
                      // additional fields (youtubeSeo, embedding, humanized
                      // narration). Persist the enriched object.
                      const enrichedStory = refinedCtx.story ?? refined;
                      // H3 FIX: respect persistMode. On the regenerate path
                      // ('return-candidate') the caller persists atomically via
                      // replaceStoryAtomically; persisting here as well would
                      // create an orphaned duplicate story row per regeneration.
                      if (persistMode === 'return-candidate') {
                        logger.info(
                          { attempt, requestId, score: refinedVerdict.overallScore, grade: refinedVerdict.grade },
                          'Refinement succeeded — returning candidate (persistMode=return-candidate, not persisted)'
                        );
                        return { story: enrichedStory, saved: false };
                      }
                      const persisted = await createStory({
                        ...enrichedStory,
                        // M20: mirror the orchestrator persist path — omit userId
                        // when unset instead of writing a literal 'unknown' owner.
                        ...(userId !== undefined ? { userId } : {}),
                        ...(forceNew ? { deduplicationKey: buildForceNewDedupKey(enrichedStory.seed || '', jobId) } : {}),
                      } as Parameters<typeof createStory>[0]);
                      // Enqueue idempotent background SEO/embedding jobs
                      // mirroring the orchestrator persist path. Stage 11
                      // may have set embedding already (skipped below if so).
                      try {
                        const conceptText = [enrichedStory.title, enrichedStory.theme || '', enrichedStory.seed || '', enrichedStory.episodes[0]?.synopsis || '', enrichedStory.episodes[1]?.synopsis || '']
                          .filter(Boolean).join(' | ');
                        const bgJobs: Promise<unknown>[] = [];
                        // M6: Stage 9 already produced YouTube SEO (persisted by
                        // createStory). Only enqueue the background SEO job as a
                        // fallback when none exists — otherwise every story pays
                        // for the generateYouTubeSEO call twice.
                        if (!enrichedStory.youtubeSeo) {
                          bgJobs.push(
                            addBackgroundSeoJob({
                              storyId: persisted.id,
                              storyTitle: enrichedStory.title,
                              genre: enrichedStory.genre,
                              protagonistName: enrichedStory.characters?.find((c) => c.role === 'protagonist')?.name || refinedCtx.blueprint?.protagonistName || 'Unknown',
                              episodeHook: enrichedStory.episodes[0]?.hook || 'Watch this story',
                              episodeCount: enrichedStory.episodes?.length ?? 1,
                            })
                          );
                        }
                        if (!enrichedStory.embedding || enrichedStory.embedding.length === 0) {
                          bgJobs.push(addBackgroundEmbeddingJob({ storyId: persisted.id, conceptText }));
                        }
                        await Promise.all(bgJobs);
                      } catch (bgErr) {
                        logger.warn({ err: String(bgErr) }, 'Background job enqueue failed after refinement');
                      }
                      logger.info(
                        { attempt, requestId, score: refinedVerdict.overallScore, grade: refinedVerdict.grade, storyId: persisted.id },
                        'Refinement succeeded — story persisted with post-stage-5 stages applied'
                      );
                      return { story: persisted, saved: true };
                    } catch (persistErr) {
                      // If persistence (or stage 10 monetization reject) fails,
                      // fall through to the normal retry path so the story is
                      // not lost and the monetization reject bubbles up to the
                      // worker's error handling (rather than silently persisting
                      // a takedown-liable row).
                      logger.warn(
                        { err: String(persistErr), attempt, requestId },
                        'Refinement persistence / post-stage-5 failed — falling through to pipeline retry'
                      );
                    }
                  }
                  // Refinement improved score but not enough — use as
                  // preloaded for the next pipeline retry (re-uses bibles).
                  preloadedStory = refined;
                  refinedApplied = true;
                  refinementInfo = `plan: ${plan.approach} (score ${refinedVerdict?.overallScore ?? '?'})`;
                } catch (refineErr) {
                  logger.warn(
                    { err: String(refineErr), attempt, requestId },
                    'Refinement application failed — retrying with raw candidate'
                  );
                  preloadedStory = err.storyCandidate;
                  refinementInfo = 'refinement_failed';
                }
                logger.info(
                  { attempt, requestId, targetAreas: plan.targetAreas, approach: plan.approach },
                  'Quality refinement plan generated for retry'
                );
              } else {
                logger.info(
                  { attempt, requestId, targetAreas: plan.targetAreas },
                  'Refinement plan duplicates previous approach — retrying without plan'
                );
              }
            }
          }
        } catch (judgeErr) {
          logger.warn({ err: String(judgeErr) }, 'Quality judge failed during retry planning — retrying blind');
        }
      }

      // H17: Blind retry (no refinement plan available or refinement failed)
      // must NOT re-judge the identical story. The episodes:done checkpoint
      // (fenced per BullMQ attempt, shared across quality retries) would make
      // the next attempt skip stage 5 and re-run stages 7/8 on byte-identical
      // text — burning stage-7 AI calls on 50 scenes and deterministically
      // re-failing. Clear the episodes checkpoint so episodes genuinely
      // regenerate from the (preloaded or fresh) bibles.
      if (!refinedApplied && attempt <= qualityMaxRetries) {
        try {
          const ckptScope = options.attempt ? `:attempt:${options.attempt}` : '';
          await getSharedRedis().del(
            `job:${jobId}${ckptScope}:stage:episodes:done`,
            `job:${jobId}${ckptScope}:candidate:v1`
          );
          logger.info({ attempt, requestId }, 'H17: blind quality retry — cleared episodes checkpoint so episodes regenerate');
        } catch (clearErr) {
          logger.warn({ err: clearErr, requestId }, 'H17: failed to clear episodes checkpoint');
        }
      }

      logger.warn(
        { attempt, qualityScore: err.qualityScore, grade: err.qualityGrade, refinementInfo, jobId, requestId },
        `Quality check failed (attempt ${attempt}/${qualityMaxRetries + 1})`
      );
    }
  }
  // QUALITY-6: After exhausting retries, persist and return the best attempt
  // if it meets the publish threshold, instead of throwing.
  if (bestAttempt && publishThreshold > 0 && bestAttempt.score >= publishThreshold) {
    // H2 FIX: The best attempt was captured the moment stage 8 (quality) threw,
    // so stages 9 (SEO), 10 (copyright sweep — SECURITY-CRITICAL), and 11
    // (embedding) never ran on it. Persisting it raw would publish a story
    // that was never copyright-checked and has no SEO/embedding. Run the
    // post-stage-5 stages now (mirrors the CRIT-10 refinement path) so the
    // released story is complete and monetization-safe. If stage 10 hard-
    // rejects (takedown-liable terms), we abort the publish instead of
    // persisting a liable row.
    let enrichedStory = bestAttempt.story;
    try {
      const { ctx: bestCtx, helpers: bestHelpers } = buildStageContextFromStory(bestAttempt.story, {
        jobId,
        requestId,
        primaryGenre,
        qualityFloor,
        gradeFloor,
        aiScoreLimit,
        storyBudget,
        persistMode,
        ...(seed !== undefined ? { seed } : {}),
      });
      await runPostStage5Stages(bestCtx, bestHelpers);
      enrichedStory = bestCtx.story ?? bestAttempt.story;
    } catch (stageErr) {
      // Stage 10 monetization hard-reject (or another post-stage failure).
      // Do NOT publish a takedown-liable / degraded row — surface and give up.
      logger.warn(
        { err: String(stageErr), requestId, score: bestAttempt.score },
        'H2: best-effort publish aborted — skipped-stage recovery failed (e.g. copyright reject)'
      );
      throw lastError ?? (stageErr instanceof Error ? stageErr : new Error(String(stageErr)));
    }

    // H2: Surface the degradation on the story record. This story met the
    // publish threshold but NOT the quality floor, so it is a best-effort
    // release. Record it in qualityIssues (existing field — no schema change)
    // so the degradation is visible to operators and any UI that renders
    // quality issues, instead of being silently published.
    const degradationNote = `Published below quality floor (best-effort): score ${bestAttempt.score} < floor ${qualityFloor} after retries`;
    enrichedStory.metadata = {
      ...enrichedStory.metadata,
      qualityIssues: [...(enrichedStory.metadata?.qualityIssues ?? []), degradationNote],
    };
    logger.warn(
      { requestId, score: bestAttempt.score, grade: bestAttempt.grade, qualityFloor },
      'H2: best-effort publish — quality floor not met after retries; skipped stages 9-11 recovered before release'
    );

    // H3 FIX: respect persistMode. On the regenerate path ('return-candidate')
    // the caller persists atomically; persisting here as well would orphan a
    // duplicate story row per regeneration.
    if (persistMode === 'return-candidate') {
      logger.info(
        { requestId, score: bestAttempt.score, grade: bestAttempt.grade },
        'Retries exhausted — returning best attempt as candidate (persistMode=return-candidate, not persisted)'
      );
      return { story: enrichedStory, saved: false };
    }
    try {
      const persisted = await createStory({
        ...enrichedStory,
        // M20: omit userId when unset instead of writing 'unknown'.
        ...(userId !== undefined ? { userId } : {}),
        ...(forceNew ? { deduplicationKey: buildForceNewDedupKey(enrichedStory.seed || '', jobId) } : {}),
      } as Parameters<typeof createStory>[0]);
      logger.info(
        { requestId, score: bestAttempt.score, grade: bestAttempt.grade, storyId: persisted.id },
        'Retries exhausted — publishing best attempt (meets publish threshold)'
      );
      return { story: persisted, saved: true };
    } catch (persistErr) {
      logger.warn(
        { err: String(persistErr), requestId },
        'Best attempt persistence failed — throwing last error'
      );
    }
  }
  throw lastError ?? new Error('Pipeline retry exhausted');
}

/**
 * H3+H4: Race a promise against a wall-clock watchdog timer. Unlike the
 * previous setTimeout-based withTimeout, this uses a worker-thread watchdog
 * (from watchdog.ts) that fires regardless of main-thread event loop
 * saturation. The AbortController is aborted when the watchdog fires, so
 * the orphaned runGenerationCore can detect the abort between stages (H4)
 * and stop making AI calls instead of running indefinitely.
 */
async function withWatchdogTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  jobId: string,
  cannedFallbackEnabled: boolean = false
): Promise<T> {
  const wd = createWatchdogAbortController(timeoutMs, 'pipeline', jobId);
  try {
    const timeoutPromise = wd.fired.then((r) => {
      if (r.fired) {
        throw new Error(`Pipeline timed out after ${timeoutMs}ms (job ${jobId})`);
      }
      return new Promise<T>(() => {});
    });
    // H4+M11: Run the pipeline inside a per-job async context so AI calls see
    // the correct jobId and abortSignal even when multiple jobs overlap due to
    // concurrent stages, Promise.all, or retry loops.
    return await Promise.race([
      runWithAIPipelineContext(jobId, wd.controller.signal, () => fn(wd.controller.signal), cannedFallbackEnabled),
      timeoutPromise,
    ]);
  } finally {
    wd.cancel();
  }
}
