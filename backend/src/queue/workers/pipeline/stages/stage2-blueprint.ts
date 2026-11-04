/**
 * Stage 2: Story blueprint.
 *
 * Generates the high-level plan (title, protagonist, setting, theme, logline)
 * that stages 3/4/5 all consume. On regeneration failure, falls back to a
 * minimal blueprint derived from the seed so the pipeline always has SOMETHING
 * to chew on. The generated blueprint is copyright-scanned and sanitised
 * in-place before being cached.
 */

import type { Story, StageContext, StageHelpers } from '../types.js';
import { generateStoryBlueprint, type StoryBlueprint } from '../../../../lib/episode-generator.js';
import { hasCopyrightHit, scanObject } from '../../../../lib/copyright-filter.js';
import { logFallback } from '../../../../services/generation-logger.js';
import { sanitizeFreeOfHits } from '../helpers.js';
import { logger } from '../../../../services/logger.js';
import {
  claimConceptTokens,
  extractClaimTokens,
  formatClaimedTokensForPrompt,
  getClaimedConceptTokens,
} from '../../../../services/concept-registry.js';

type StoryBlueprintCheckpoint = Story & {
  protagonistName?: string;
  protagonistAge?: string;
  setting?: string;
};

export async function stage2Blueprint(
  ctx: StageContext,
  { progressEmit, isStageDone, markStageDone, loadCandidate }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'blueprint', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  if (await isStageDone('blueprint')) {
    await progressEmit(10, 'blueprint', 'Skipping blueprint (already completed)...');
    const cand = await loadCandidate();
    if (cand) {
      const checkpoint = cand as StoryBlueprintCheckpoint;
      ctx.blueprint = {
        title: cand.title,
        protagonistName: checkpoint.protagonistName ?? 'Unknown',
        protagonistAge: checkpoint.protagonistAge ?? 'Unknown',
        setting: checkpoint.setting ?? 'Unknown',
        theme: cand.theme ?? 'Unknown',
        logline: cand.seed ?? 'Unknown',
      };
      logger.info(
        { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'blueprint', elapsedMs: 0, skipped: true },
        'STAGE_COMPLETED'
      );
      return;
    }
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId },
      'Blueprint stage marked done but candidate missing — regenerating'
    );
  }
  await progressEmit(10, 'blueprint', 'Creating story blueprint...');
  const avoidanceConstraints = [...(ctx.avoidanceConstraints ?? [])];
  const avoidNames = ctx.avoidCharacterNames ? new Set(ctx.avoidCharacterNames) : undefined;

  // In-flight concept registry: concurrent jobs cannot see each other through
  // the DB (stories persist only at pipeline completion), so without this they
  // routinely produced near-identical titles/motifs in the same batch. Claim
  // tokens claimed by other in-flight jobs are fed in as prompt constraints
  // up front AND hard-checked after generation (race-free via SET NX).
  const inFlightConstraints = formatClaimedTokensForPrompt(await getClaimedConceptTokens(ctx.jobId));
  avoidanceConstraints.push(...inFlightConstraints);

  let blueprint: StoryBlueprint;
  const CLAIM_CONFLICT_MAX_ATTEMPTS = 3;
  let attempt = 0;
  for (;;) {
    try {
      blueprint = await generateStoryBlueprint(
        ctx.primaryGenre,
        ctx.seed,
        avoidanceConstraints,
        avoidNames
      );
    } catch (err) {
      // No template fallback: a failed blueprint must not be silently replaced
      // with hardcoded defaults ("Sora" / "friendship and adventure"). Propagate
      // so the job regenerates from a clean state via the queue retry policy.
      // Rethrow the ORIGINAL error: its message already carries the full context
      // ("Blueprint generation failed after N attempts: <cause>") — wrapping it
      // again produced the duplicated "Blueprint generation failed: Blueprint
      // generation failed after N attempts: …" log lines.
      const errMsg = err instanceof Error ? err.message : String(err);
      await logFallback('story_planning', errMsg, ctx.seed || 'fallback_title');
      logger.error(
        { jobId: ctx.jobId, requestId: ctx.requestId, err: errMsg, seed: ctx.seed },
        'Blueprint generation failed after retries — aborting for regeneration'
      );
      throw err instanceof Error ? err : new Error(errMsg);
    }

    // Hard in-flight collision check: claim this blueprint's significant title
    // words + protagonist-name tokens. A conflict means another concurrent job
    // owns the motif — regenerate with the conflicting tokens as constraints.
    const claimTokens = extractClaimTokens(blueprint.title, blueprint.protagonistName);
    const conflicts = await claimConceptTokens(ctx.jobId, claimTokens);
    if (conflicts.length === 0) break;
    attempt += 1;
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId, attempt, conflicts },
      'Blueprint collides with an in-flight generation — regenerating with motif constraints'
    );
    if (attempt >= CLAIM_CONFLICT_MAX_ATTEMPTS) {
      const errMsg = `Blueprint motif conflicts persist after ${CLAIM_CONFLICT_MAX_ATTEMPTS} attempts: ${conflicts.join(', ')}`;
      await logFallback('story_planning', errMsg, ctx.seed || 'fallback_title');
      logger.error({ jobId: ctx.jobId, requestId: ctx.requestId, err: errMsg, seed: ctx.seed }, 'Blueprint generation failed after retries — aborting for regeneration');
      throw new Error(errMsg);
    }
    avoidanceConstraints.push(formatClaimedTokensForPrompt(conflicts).join('; '));
  }
  if (hasCopyrightHit(blueprint)) {
    const hits = scanObject(blueprint);
    logger.warn({ jobId: ctx.jobId, requestId: ctx.requestId, hits }, 'Blueprint hit copyright filter; sanitizing');
    blueprint.title = sanitizeFreeOfHits(blueprint.title, blueprint, ctx.primaryGenre);
    blueprint.protagonistName = sanitizeFreeOfHits(blueprint.protagonistName, blueprint, ctx.primaryGenre);
    blueprint.setting = sanitizeFreeOfHits(blueprint.setting, blueprint, ctx.primaryGenre);
    blueprint.theme = sanitizeFreeOfHits(blueprint.theme, blueprint, ctx.primaryGenre);
    blueprint.logline = sanitizeFreeOfHits(blueprint.logline, blueprint, ctx.primaryGenre);
  }
  await markStageDone('blueprint');
  ctx.blueprint = blueprint;
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'blueprint', elapsedMs: Math.round(elapsedMs) },
    'STAGE_COMPLETED'
  );
}
