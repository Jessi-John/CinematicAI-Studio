/**
 * Stage 11: Embedding generation.
 *
 * Builds a 5-part concept string (title + theme + seed + first two synopses)
 * and computes its semantic embedding. The embedding is used downstream by
 * the uniqueness analyzer to detect near-duplicate future stories.
 *
 * PR-002: hard wall-clock timeout via the worker-thread watchdog. The
 * generateEmbedding helper uses an internal JS-level setTimeout that does
 * NOT fire when the main thread is saturated (REL-006). The watchdog
 * ensures the stage always advances.
 *
 * PR-003: best-effort. If the embedding fails (network, timeout, schema),
 * the story still persists with `embedding = null` — the uniqueness check
 * is a soft signal, not a hard gate.
 */

import type { StageContext, StageHelpers } from '../types.js';
import { generateEmbedding } from '../../../../lib/embeddings.js';
import { startWatchdog } from '../../../../lib/watchdog.js';
import { logger } from '../../../../services/logger.js';

const EMBED_STAGE_TIMEOUT_MS = 90_000; // 1.5 min — embedding is small

export async function stage11Embedding(
  ctx: StageContext,
  { progressEmit }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'embedding', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  await progressEmit(93, 'embedding', 'Computing semantic fingerprint...');
  const story = ctx.story!;
  const conceptText = [
    story.title,
    story.theme || '',
    story.seed || '',
    story.episodes[0]?.synopsis || '',
    story.episodes[1]?.synopsis || '',
  ]
    .filter(Boolean)
    .join(' | ');
  // PR-001: per-statement timing to localize any post-Stage-9 stall.
  const conceptStartNs = process.hrtime.bigint();
  logger.info({ jobId: ctx.jobId, requestId: ctx.requestId, conceptChars: conceptText.length }, 'STAGE11_BUILD_CONCEPT');
  const embedWatchdog = startWatchdog({
    timeoutMs: EMBED_STAGE_TIMEOUT_MS,
    label: 'stage11_embedding',
    jobId: ctx.jobId,
  });
  let embedding: number[] | null = null;
  try {
    embedding = await Promise.race([
      generateEmbedding(conceptText, ctx.jobId),
      embedWatchdog.fired.then((r) => {
        if (r.reason === 'timeout') {
          throw new Error(
            `embedding watchdog fired after ${Math.round(r.elapsedMs)}ms`
          );
        }
        return null;
      }),
    ]);
  } catch (err) {
    // H5: The module header claims "best-effort. If the embedding fails the
    // story still persists with embedding = null." Previously there was no
    // catch block — the watchdog timeout threw and propagated up through
    // runGenerationCore → withTimeout catch → processStoryJob catch → job
    // marked failed. createStory was never reached, losing the story after
    // 15-25 min of pipeline work. Now we catch and set embedding = null so
    // the story persists as documented.
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId, err: err instanceof Error ? err.message : String(err) },
      'Embedding failed (best-effort) — story will persist with null embedding'
    );
    embedding = null;
  } finally {
    embedWatchdog.cancel();
  }
  const conceptMs = Number(process.hrtime.bigint() - conceptStartNs) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, conceptMs: Math.round(conceptMs), gotVec: !!embedding, dim: embedding?.length },
    'STAGE11_EMBED_RETURNED'
  );
  if (!embedding || embedding.length === 0) {
    // PR-003: embedding is best-effort. If it fails (network, timeout, schema),
    // we still want the story to persist with a null embedding. The
    // generateEmbedding helper already returns null on failure, so the only
    // way to reach this branch is timeout from the watchdog above.
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId },
      'Embedding unavailable — story will persist with null embedding'
    );
  } else {
    story.embedding = embedding;
  }
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    {
      jobId: ctx.jobId,
      requestId: ctx.requestId,
      stage: 'embedding',
      elapsedMs: Math.round(elapsedMs),
      embeddingDim: embedding?.length ?? 0,
    },
    'STAGE_COMPLETED'
  );
}
