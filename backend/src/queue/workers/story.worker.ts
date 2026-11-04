/**
 * Phase 2 / Fix #21: BullMQ worker entry point.
 *
 * The actual pipeline logic (10 stages, orchestrator, death-loop guard,
 * quality retry loop) lives in `./pipeline/`. This file is a thin
 * adapter that:
 *   1. Subscribes the BullMQ `Job<StoryJobData>` shape to the pipeline's
 *      `RunGenerationOptions` shape.
 *   2. Translates progress events from the pipeline into the BullMQ +
 *      Redis-pubsub + Redis-state triple that the SSE consumer reads.
 *   3. Handles post-pipeline verification (DB row exists), state stamping,
 *      webhook delivery, and DLQ enqueue on failure.
 *
 * For backward compat, `runStoryPipeline` and `__resetDeathLoopGuard`
 * are re-exported from this module so existing imports
 * (`import { runStoryPipeline } from '../queue/workers/story.worker.js'`)
 * keep working. The tests that need to reset the death-loop guard do the
 * same import, so this re-export is part of the public surface.
 */

import type { Job } from 'bullmq';
import type { StoryJobData, JobProgress } from '../index.js';
import { publishProgress, setJobState, getJobState, markJobFailed } from '../redis-pubsub.js';
import { DuplicateStoryError, DuplicateSeoTitleError } from '../../database/prisma-storage.js';
import { prisma } from '../../database/prisma.js';
import { refundTokenBudget, clearTokenSpend } from '../../services/token-budget.js';
import { callWebhook } from '../../services/webhook.js';
import { logger } from '../../services/logger.js';
import {
  runStoryPipeline,
  __resetDeathLoopGuard,
  type RunGenerationOptions,
  type RunGenerationResult,
} from './pipeline/index.js';
import { getStoryTokenBudgetEstimate } from '../../config/env.js';

export { runStoryPipeline, __resetDeathLoopGuard };
export type { RunGenerationOptions, RunGenerationResult };

/**
 * BullMQ entry point. Each story-generation job calls this function exactly
 * once. Returns the persisted storyId on success; throws on any error
 * (BullMQ then re-queues per its retry policy).
 */
export async function processStoryJob(job: Job<StoryJobData>): Promise<unknown> {
  const { jobId, genre, seed, webhookUrl, userId, retryFromDlq = false, forceNew = false } = job.data;
  const requestId = job.data.requestId || jobId;
  const primaryGenre = genre[0]!;

  // Guard all job state writes to prevent unhandled rejections from crashing the worker.
  // M16: Preserve original state fields (genre, seed, createdAt, requestId) by
  // merging updates with the existing state instead of overwriting it. Previously
  // every progress emit overwrote the state with only {status, progress, stage,
  // message, updatedAt} — losing genre/seed/createdAt/requestId after the first
  // progress event.
  const safeSetState = async (state: Record<string, unknown>) => {
    try {
      // Read current state first, then merge updates
      const current = await getJobState(jobId);
      await setJobState(jobId, { ...(current || {}), ...state });
    } catch (err) {
      logger.warn({ jobId, err }, 'setJobState failed, continuing');
    }
  };

  await safeSetState({
    status: 'active',
    progress: 0,
    stage: 'init',
    message: 'Initializing story generation...',
    genre: primaryGenre,
    seed: seed || '',
    createdAt: Date.now(),
    requestId,
    // H1: Persist the owner id in the job state (7-day TTL) so SSE/status
    // ownership checks still resolve after the BullMQ queue entry is cleaned
    // (removeOnComplete), letting a reconnecting client re-authorize.
    ...(userId !== undefined ? { userId } : {}),
  });

  const emit = async (
    type: JobProgress['type'],
    progress: number,
    stage?: string,
    message?: string,
    data?: unknown
  ) => {
    try {
      await publishProgress({
        jobId,
        type,
        progress: progress ?? 0,
        ...(stage !== undefined ? { stage } : {}),
        ...(message !== undefined ? { message } : {}),
        data,
        timestamp: Date.now(),
        requestId,
      });
    } catch (err) {
      logger.warn({ jobId, err }, 'publishProgress failed, continuing');
    }
    try {
      await job.updateProgress(progress);
    } catch (err) {
      logger.warn({ jobId, err }, 'job.updateProgress failed, continuing');
    }
    if (type !== 'complete' && type !== 'error') {
      await safeSetState({
        status: 'active',
        progress,
        stage,
        message,
        updatedAt: Date.now(),
      });
    }
  };

  try {
    logger.info({ jobId, requestId }, 'PROCESS_STORY_PIPELINE_STARTED');
    const { story: saved } = await runStoryPipeline({
      genre,
      // REL-013: Pass seed through. Without this, ctx.seed is undefined
      // inside the pipeline, buildStoryFromEpisodes drops the seed from the
      // story object, and the DB row gets seed=NULL — breaking lexical
      // dedupe (findFirst({where:{seed}}) never matches).
      ...(seed !== undefined ? { seed } : {}),
      ...(userId !== undefined ? { userId } : {}),
      jobId,
      requestId,
      // H7: Fence checkpoint keys with the BullMQ attempt number so a retry
      // never reads checkpoints written by an orphaned previous attempt.
      attempt: job.attemptsMade,
      // M28: Reserve an atomic per-job token budget estimate at the pipeline gate.
      tokenBudgetEstimate: getStoryTokenBudgetEstimate(),
      // M28: When this is a DLQ retry, accept the story regardless of quality
      // score and grade. See runStoryPipeline for the override logic.
      retryFromDlq,
      // M32: Pass forceNew through so the persist stage can generate a unique
      // deduplicationKey and bypass the DB unique index for intentional duplicates.
      forceNew,
      // REL-016: Pass emit through. Without this, runStoryPipeline defaults
      // safeEmit to noopEmit and every progress event from the pipeline is
      // silently dropped. The SSE consumer only received heartbeats and the
      // final complete event (which is called via the local emit, not through
      // runStoryPipeline). With emit wired up, the SSE stream shows real
      // progress for the duration of the job.
      emit,
      persistMode: 'create',
    });
    logger.info(
      { jobId, requestId, storyId: saved.id, stage: 'after_pipeline' },
      'PROCESS_STORY_PIPELINE_RETURNED'
    );

    // REL-019: Verify the story was actually persisted before emitting 'complete'.
    // createStory() throws on validation/constraint failures, but a transaction
    // commit or connection issue mid-write could cause silent data loss. The SSE
    // client sees 'complete' and the job is marked done, but no DB row exists.
    const verifyStartNs = process.hrtime.bigint();
    logger.info({ jobId, storyId: saved.id, stage: 'verify_db' }, 'VERIFY_DB_STARTED');
    const verified = await prisma().story.findUnique({ where: { id: saved.id } });
    const verifyMs = Number(process.hrtime.bigint() - verifyStartNs) / 1_000_000;
    logger.info(
      { jobId, storyId: saved.id, found: !!verified, elapsedMs: Math.round(verifyMs) },
      'VERIFY_DB_COMPLETED'
    );
    if (!verified) {
      throw new Error(`Story ${saved.id} was not found in DB after createStory() returned successfully`);
    }

    const emitStartNs = process.hrtime.bigint();
    logger.info({ jobId, storyId: saved.id, stage: 'emit_complete' }, 'EMIT_COMPLETE_STARTED');
    await emit('complete', 100, 'complete', 'Generation complete!', { storyId: saved.id });
    const emitMs = Number(process.hrtime.bigint() - emitStartNs) / 1_000_000;
    logger.info(
      { jobId, storyId: saved.id, elapsedMs: Math.round(emitMs) },
      'EMIT_COMPLETE_DONE'
    );

    const setStateStartNs = process.hrtime.bigint();
    logger.info({ jobId, storyId: saved.id, stage: 'set_state_completed' }, 'SET_STATE_COMPLETED_STARTED');
    await safeSetState({
      status: 'completed',
      progress: 100,
      storyId: saved.id,
      completedAt: Date.now(),
    });
    const setStateMs = Number(process.hrtime.bigint() - setStateStartNs) / 1_000_000;
    logger.info(
      { jobId, storyId: saved.id, elapsedMs: Math.round(setStateMs) },
      'SET_STATE_COMPLETED_DONE'
    );

    // Store storyId in job data so polling fallback can find it
    // NOTE: This is wrapped in try-catch because failure here should NOT
    // cause the job to be marked as failed — the story is already persisted
    // to PostgreSQL (line ~155 above). If job.updateData throws (e.g. Redis
    // down), the SSE/poll consumer won't get the storyId in job data, but
    // the story itself is safely stored and discoverable via the stories list.
    const updateDataStartNs = process.hrtime.bigint();
    logger.info({ jobId, storyId: saved.id, stage: 'update_job_data' }, 'UPDATE_JOB_DATA_STARTED');
    try {
      await job.updateData({ ...job.data, storyId: saved.id });
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      // REL-021: "Missing key" means another worker already finished/moved this
      // job (concurrent processing after lock timeout). The story is persisted,
      // so this is a benign race — log at debug, not error.
      const level = msg.includes('Missing key for job') ? 'debug' : 'error';
      logger[level]({ err: updateErr, jobId, storyId: saved.id }, 'UPDATE_JOB_DATA_FAILED — story already saved, continuing');
    }
    const updateDataMs = Number(process.hrtime.bigint() - updateDataStartNs) / 1_000_000;
    logger.info(
      { jobId, storyId: saved.id, elapsedMs: Math.round(updateDataMs) },
      'UPDATE_JOB_DATA_DONE'
    );
    logger.info(
      { jobId, requestId, storyId: saved.id, stage: 'final_complete' },
      'JOB_FINAL_COMPLETE'
    );

    // HIGH-8: Clean up per-job token spend tracking on success.
    // Without this, the map accumulates entries for every completed job,
    // bounded only by LRU eviction at MAX_TRACKED_SPEND_JOBS (1000).
    clearTokenSpend(jobId);

    // Fire webhook if configured — errors are non-blocking.
    if (webhookUrl) {
      callWebhook(webhookUrl, {
        event: 'complete',
        storyId: saved.id,
        jobId,
        timestamp: new Date().toISOString(),
      }).catch((err) =>
        logger.error({ err, webhookUrl, storyId: saved.id, jobId }, 'Completion webhook delivery failed')
      );
    }

    return { storyId: saved.id };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // DuplicateStoryError: The (genre, seed) unique constraint was violated.
    // The story concept already exists — fail the job with a clear message
    // instead of sending it to the DLQ (no point retrying a duplicate).
    if (err instanceof DuplicateStoryError) {
      const dupMsg = `Duplicate story concept: genre=${err.genre}, seed=${err.seed} — use a different seed or pass forceNew=true`;
      logger.warn({ jobId, requestId, genre: err.genre, seed: err.seed }, dupMsg);
      await emit('error', 0, 'error', dupMsg);
      await markJobFailed(jobId, dupMsg);
      await refundTokenBudget(jobId, 0, 0).catch((refundErr) =>
        logger.warn({ jobId, err: refundErr }, 'Token budget refund failed during cleanup')
      );
      // DLQ filtering happens in worker-factory.ts failed handler
      // (checks skipDlq property on the error). The throw below is needed
      // so BullMQ fires the failed event for logging and metrics.
      if (webhookUrl) {
        callWebhook(webhookUrl, {
          event: 'error',
          storyId: '',
          jobId,
          data: { error: dupMsg, code: 'DUPLICATE_STORY' },
          timestamp: new Date().toISOString(),
        }).catch((webhookErr) =>
          logger.error({ err: webhookErr, webhookUrl, jobId }, 'Error webhook delivery failed')
        );
      }
      throw err;
    }

    // LIVE-5: SEO title is too similar to an existing story — terminal failure.
    if (err instanceof DuplicateSeoTitleError) {
      const dupMsg = `SEO title too similar to an existing story: "${err.title}" vs "${err.existingTitle}" — use a different seed or title`;
      logger.warn({ jobId, requestId, title: err.title, existingTitle: err.existingTitle }, dupMsg);
      await emit('error', 0, 'error', dupMsg);
      await markJobFailed(jobId, dupMsg);
      await refundTokenBudget(jobId, 0, 0).catch((refundErr) =>
        logger.warn({ jobId, err: refundErr }, 'Token budget refund failed during cleanup')
      );
      if (webhookUrl) {
        callWebhook(webhookUrl, {
          event: 'error',
          storyId: '',
          jobId,
          data: { error: dupMsg, code: 'DUPLICATE_SEO_TITLE' },
          timestamp: new Date().toISOString(),
        }).catch((webhookErr) =>
          logger.error({ err: webhookErr, webhookUrl, jobId }, 'Error webhook delivery failed')
        );
      }
      throw err;
    }

    logger.error({ jobId, requestId, err: errMsg }, 'Story generation failed');

    // H6: BullMQ fires processStoryJob's catch on EVERY failed attempt, but
    // the SSE stream tears down on ANY 'error' event (redis-pubsub.ts). Only
    // signal terminal failure once all attempts are exhausted; for retryable
    // attempts, emit a progress event so the client sees a retry, not a death.
    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminalAttempt = job.attemptsMade >= maxAttempts;
    if (isTerminalAttempt) {
      await emit('error', 0, 'error', `Generation failed: ${errMsg}`);
      await markJobFailed(jobId, errMsg);
    } else {
      await emit('progress', 0, 'retrying', `Generation attempt ${job.attemptsMade} of ${maxAttempts} failed — retrying (${errMsg.slice(0, 200)})`);
    }

    // REL-003 / M1 — Attempt compensation: refund token budget so the story is
    // not left in a partial state and token consumption is reversed.
    // DLQ enqueue is handled by the worker's `failed` event (worker-factory.ts).
    // We removed the redundant catch-block DLQ write here — both paths previously
    // wrote the same data with the same key, and the `failed` event is the
    // authoritative single path. If the DLQ write fails, BullMQ's retry mechanism
    // on the `failed` event (with backoff) handles retries; the catch block had no
    // backoff and would duplicate the entry on the next process restart.
    // NOTE: We pass 0,0 because the actual token spend is tracked by the
    // checkAndRecordTokenBudget call and will be refunded via the job's
    // chargeSource tracking. A full refund requires knowing the actual
    // prompt/completion tokens consumed, which are not available at this level.
    await refundTokenBudget(jobId, 0, 0).catch((refundErr) =>
      logger.warn({ jobId, err: refundErr }, 'Token budget refund failed during cleanup')
    );

    // Fire error webhook if configured — errors are non-blocking. Webhooks
    // fire only on terminal failure (a transient attempt that a later retry
    // fixes must not page the user's endpoint).
    if (webhookUrl && isTerminalAttempt) {
      callWebhook(webhookUrl, {
        event: 'error',
        storyId: '',
        jobId,
        data: { error: errMsg },
        timestamp: new Date().toISOString(),
      }).catch((webhookErr) =>
        logger.error({ err: webhookErr, webhookUrl, jobId }, 'Error webhook delivery failed')
      );
    }

    throw err;
  }
}
