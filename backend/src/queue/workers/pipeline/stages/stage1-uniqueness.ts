/**
 * Stage 1: Uniqueness analysis.
 *
 * Reads the existing-story embeddings and produces an `avoidanceConstraints`
 * list for downstream prompt construction. Failure is fatal (we cannot
 * generate without uniqueness constraints) and bubbles up to the orchestrator
 * which will mark the job failed and send it to the DLQ.
 */

import type { StageContext, StageHelpers } from '../types.js';
import type { Story } from '../../../../services/types.js';
import { analyzeExistingStories, generateUniqueStoryPrompt } from '../../../../services/uniqueness.js';
import type { Genre } from '../../../../services/types.js';
import { logger } from '../../../../services/logger.js';

export async function stage1Uniqueness(
  ctx: StageContext,
  { progressEmit, isStageDone, markStageDone, loadCandidate }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'uniqueness', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  if (await isStageDone('uniqueness')) {
    await progressEmit(6, 'uniqueness', 'Skipping uniqueness (already completed)...');
    const checkpoint = await loadCandidate() as (Story & { avoidanceConstraints?: string[]; avoidCharacterNames?: string[] }) | null;
    if (checkpoint?.avoidanceConstraints) {
      ctx.avoidanceConstraints = checkpoint.avoidanceConstraints;
    }
    if (checkpoint?.avoidCharacterNames) {
      ctx.avoidCharacterNames = checkpoint.avoidCharacterNames;
    }
    logger.info(
      { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'uniqueness', elapsedMs: 0, skipped: true },
      'STAGE_COMPLETED'
    );
    return;
  }
  await progressEmit(6, 'uniqueness', 'Analyzing existing stories for uniqueness...');
  let avoidanceConstraints: string[] = [];
  let avoidCharacterNames: string[] = [];
  try {
    const analysis = await analyzeExistingStories();
    const uniquePrompt = generateUniqueStoryPrompt(ctx.primaryGenre as Genre, analysis, ctx.seed);
    avoidanceConstraints = uniquePrompt.constraints;
    avoidCharacterNames = Array.from(
      new Set<string>([...analysis.usedCharacterNames, ...analysis.usedCharacterFullNames])
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: ctx.jobId, requestId: ctx.requestId, err: errMsg }, 'Stage 1 uniqueness failed');
    throw new Error(`Uniqueness analysis failed: ${errMsg}. Cannot proceed without uniqueness constraints.`);
  }
  await markStageDone('uniqueness');
  ctx.avoidanceConstraints = avoidanceConstraints;
  ctx.avoidCharacterNames = avoidCharacterNames;
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'uniqueness', elapsedMs: Math.round(elapsedMs) },
    'STAGE_COMPLETED'
  );
}
