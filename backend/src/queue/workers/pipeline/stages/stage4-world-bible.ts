/**
 * Stage 4: World bible.
 *
 * Generates antagonist / supporting-cast / environment details that the
 * image-prompt stage needs. Runs concurrently with stage 3 (both only
 * require the blueprint to be set) — the orchestrator fans them out.
 *
 * On regeneration failure, falls back to a default world bible so stage 5
 * has a usable setting to reference. (BIZ-003 — same defensive pattern
 * as the character-bible stage.)
 */

import type { StageContext, StageHelpers } from '../types.js';
import { generateWorldBible } from '../../../../services/world-bible.js';
import { logFallback } from '../../../../services/generation-logger.js';
import { defaultWorldBible } from '../helpers.js';
import { logger } from '../../../../services/logger.js';

export async function stage4WorldBible(
  ctx: StageContext,
  { progressEmit, isStageDone, markStageDone, loadCandidate }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'world_bible', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  if (await isStageDone('world_bible')) {
    await progressEmit(18, 'world_bible', 'Skipping world bible (already completed)...');
    const cand = await loadCandidate();
    const restoredWorldBible = cand
      ? (cand as unknown as { worldBible?: StageContext['worldBible'] }).worldBible
      : undefined;
    if (restoredWorldBible) {
      ctx.worldBible = restoredWorldBible;
      logger.info(
        { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'world_bible', elapsedMs: 0, skipped: true },
        'STAGE_COMPLETED'
      );
      return;
    }
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId },
      'World bible stage marked done but candidate missing — using default world bible'
    );
    ctx.worldBible = defaultWorldBible();
    logger.info(
      { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'world_bible', elapsedMs: 0, skipped: true, fallback: true },
      'STAGE_COMPLETED'
    );
    return;
  }
  await progressEmit(18, 'world_bible', 'Designing world and supporting cast...');
  const blueprint = ctx.blueprint!;
  let worldBible;
  try {
    worldBible = await generateWorldBible({
      genre: ctx.primaryGenre,
      setting: blueprint.setting,
      protagonistName: blueprint.protagonistName,
      theme: blueprint.theme,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logFallback('world_bible', errMsg, blueprint.protagonistName);
    worldBible = defaultWorldBible();
  }
  await markStageDone('world_bible');
  ctx.worldBible = worldBible;
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'world_bible', elapsedMs: Math.round(elapsedMs) },
    'STAGE_COMPLETED'
  );
}
