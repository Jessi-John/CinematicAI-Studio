/**
 * Worker factory: creates a BullMQ Worker that processes story generation jobs.
 * Used by both index.ts (in-process mode).
 */

import { Worker, type Job } from 'bullmq';
import { getConnectionConfig, workerConfig, getStoryDlq, type StoryJobData, type DlqEntry } from '../index.js';
import { processStoryJob } from './story.worker.js';
import { publishProgress } from '../redis-pubsub.js';
import { logger } from '../../services/logger.js';
import {
  observeJobStarted,
  observeJobRetry,
  observeJobFailed,
  observeJobTerminal,
} from './job-lifecycle.js';
import { e2eTestBypassEnabled } from '../../config/env.js';

export interface WorkerOptions {
  concurrency?: number;
}

export interface StoryWorker {
  worker: Worker<StoryJobData>;
  closeDlq: () => Promise<void>;
}

// Worker throughput limits — configurable via environment.
// Lazy getters so env values are read after validateAndLoadEnv() completes.
// In E2E test mode, bypass the rate limiter (set to a very high value)
// so that canned jobs process instantly without artificial throttling.
// Gated on non-production so a leaked E2E_TEST=true cannot remove throttling.
function isE2ETestMode(): boolean {
  return e2eTestBypassEnabled();
}
function getWorkerConcurrency(): number {
  return Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || '2', 10));
}
function getWorkerRateLimitMax(): number {
  return isE2ETestMode()
    ? 10_000
    : Math.max(1, parseInt(process.env.WORKER_RATE_LIMIT_MAX || '10', 10));
}
function getWorkerRateLimitWindowMs(): number {
  return Math.max(1000, parseInt(process.env.WORKER_RATE_LIMIT_WINDOW_MS || '60000', 10));
}

export function createStoryWorker(options: WorkerOptions = {}): StoryWorker {
  const concurrency = options.concurrency ?? getWorkerConcurrency();

  const worker = new Worker<StoryJobData>(
    'story-generation',
    async (job: Job<StoryJobData>) => {
      observeJobStarted(job);
      logger.info({ jobId: job.id, name: job.name }, 'Processing job');
      const result = await processStoryJob(job);
      logger.info({ jobId: job.id }, 'Job completed');
      return result;
    },
    {
      connection: getConnectionConfig(),
      concurrency,
      limiter: {
        max: getWorkerRateLimitMax(),
        duration: getWorkerRateLimitWindowMs(),
      },
      lockDuration: workerConfig.lockDuration,
      lockRenewTime: workerConfig.lockRenewTime,
      stalledInterval: 300_000, // 5 min — pipeline takes 15-25 min/story; 60s was too aggressive
      // L30: Allow 2 stalled checks before failing — a single stall during a
      // long AI call is normal; 2 consecutive stalls indicate a real problem.
      maxStalledCount: 2,
    }
  );

  worker.on('completed', (job) => {
    if (!job) return;
    observeJobTerminal(job, 'completed');
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;

    // H6: BullMQ fires 'failed' on EVERY failed attempt, not just the final
    // one. Without this guard, the first failed attempt would add a DLQ entry
    // and publish an 'error' SSE event — tearing down the client stream even
    // if subsequent retries succeed. Only treat as terminal when all attempts
    // are exhausted.
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      observeJobRetry(job);
      logger.warn(
        { jobId: job.id, attemptsMade: job.attemptsMade, maxAttempts, err: err.message },
        'Job attempt failed (will retry) — not adding to DLQ or publishing error'
      );
      return;
    }

    // Terminal outcome: count once after all retries are exhausted.
    observeJobFailed(job, err);

    // Skip DLQ for non-transient errors that cannot be retried.
    // DuplicateStoryError has skipDlq=true set — duplicates will never
    // succeed on retry, so storing them in the DLQ only adds noise.
    if ((err as { skipDlq?: boolean }).skipDlq) {
      logger.warn(
        { jobId: job.id, attemptsMade: job.attemptsMade, err: err.message },
        'Job failed with non-transient error — skipping DLQ'
      );
      return;
    }

    // Persist failed job to DLQ for post-mortem analysis.
    // BullMQ 5.x does not auto-move jobs to a DLQ; failed jobs are removed from
    // the main queue after removeOnFail TTL (24 h). The DLQ entry survives 7 days.
    try {
      const dlqEntry: DlqEntry = {
        ...job.data,
        _failedReason: err.message,
        _failedAt: Date.now(),
      };
      await getStoryDlq().add('failed-story', dlqEntry, { jobId: `dlq-${job.id}` });
    } catch (dlqErr) {
      logger.error({ jobId: job.id, dlqErr }, 'Failed to add job to DLQ');
    }
    logger.error(
      { jobId: job.id, attemptsMade: job.attemptsMade, err: err.message },
      'Job failed and added to DLQ'
    );
    await publishProgress({
      jobId: job.data.jobId,
      type: 'error',
      progress: 0,
      stage: 'error',
      message: `Generation failed: ${err.message}`,
      timestamp: Date.now(),
    });
  });

  worker.on('error', (err) => {
    // ARCH-003: "could not renew lock for job" is a known BullMQ race condition
    // when the handler throws while a lock is held. It does not indicate worker
    // failure — the job will be retried by BullMQ. Suppress to avoid noise.
    if (err.message?.includes('could not renew lock for job')) {
      logger.debug({ err }, 'Lock renewal error (non-fatal, job will retry)');
      return;
    }
    // REL-021: "Missing key for job ... updateData/moveToFinished/moveToDelayed"
    // happens when two workers process the same job concurrently (e.g. after a
    // lock timeout) and the first one completes/removes the job before the
    // second tries to update it. This is a benign race — the work was done.
    if (err.message?.includes('Missing key for job')) {
      logger.debug({ err }, 'BullMQ missing-key race (non-fatal, job already finished)');
      return;
    }
    logger.error({ err }, 'Worker error');
  });

  return {
    worker,
    closeDlq: () => getStoryDlq().close(),
  };
}
