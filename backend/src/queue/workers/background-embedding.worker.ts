/**
 * Background embedding worker — runs after story creation.
 * Computes semantic embedding and updates stories.embedding.
 *
 * Fix #14: Use worker-thread watchdog for the timeout, not a JS-level
 * `Promise.race` against `setTimeout`. Under main-thread event-loop
 * saturation, the JS timer never fires and the embedding job can hang
 * far beyond its budget. The watchdog runs in a separate thread.
 *
 * Fix #29: Failed jobs are enqueued to a dedicated `background-dlq` so
 *   an operator can see them in the admin UI. Without this, a failed
 *   embedding silently left `stories.embedding = NULL` and the only
 *   signal was a `WARN` log line. An operator chasing "why does story X
 *   not have a similarity score?" had no way to find the answer.
 *
 * Fix #35: Race-on-startup retry. The main pipeline enqueues this job
 *   immediately after `createStory()` commits, but the in-process
 *   worker in `run-worker.ts` can pick up the job before the create
 *   transaction's row becomes visible to a separate connection. We
 *   retry on `P2025` (record not found) up to 3 times with backoff so
 *   the worker waits for the row to settle.
 */

import { Worker, type Job } from 'bullmq';
import { prisma } from '../../database/prisma.js';
import { getConnectionConfig } from '../index.js';
import { generateEmbedding } from '../../lib/embeddings.js';
import { runWithAIPipelineContext } from '../../lib/ai-client.js';
import { withWallClockTimeout } from '../../lib/watchdog.js';
import { logger } from '../../services/logger.js';
import { sleep } from '../../lib/sleep.js';
import { addBackgroundDlqEntry } from '../index.js';
import { isRetriableError } from '../../lib/retry.js';
import type { BackgroundEmbeddingJobData } from '../index.js';

const EMBEDDING_TIMEOUT_MS = 60_000; // 1 minute
const MAX_NOT_FOUND_RETRIES = 3;
const NOT_FOUND_RETRY_DELAY_MS = 500;

export async function processEmbeddingJob(job: Job<BackgroundEmbeddingJobData>): Promise<void> {
  const { storyId, conceptText } = job.data;
  const contextJobId = job.id ?? `emb-${storyId}`;
  logger.info({ jobId: contextJobId, storyId }, 'Processing background embedding job');

  try {
    const embedding = await withWallClockTimeout(
      runWithAIPipelineContext(contextJobId, null, () => generateEmbedding(conceptText, contextJobId)),
      EMBEDDING_TIMEOUT_MS,
      'background_embedding',
      contextJobId
    );

    if (!embedding || embedding.length === 0) {
      logger.warn({ jobId: contextJobId, storyId }, 'Embedding generation returned empty — writing DLQ entry');
      await addBackgroundDlqEntry({
        queue: 'background-embedding',
        jobId: contextJobId,
        storyId,
        failedAt: new Date().toISOString(),
        reason: 'Embedding generation returned empty result',
      }).catch((dlqErr) =>
        logger.error({ dlqErr }, 'Failed to enqueue background embedding failure to DLQ')
      );
      return;
    }

    // Fix #35: retry on P2025 (story not yet visible to this connection).
    // This handles the race where the main pipeline enqueues the
    // background job at the end of `createStory()`'s transaction, but
    // the transaction is still in flight on the connection that
    // enqueued it. BullMQ can pick up the job on a different worker
    // process, where the new row is not yet visible.
    for (let attempt = 0; attempt < MAX_NOT_FOUND_RETRIES; attempt++) {
      try {
        await prisma().story.update({
          where: { id: storyId },
          data: { embedding },
        });
        logger.info({ jobId: contextJobId, storyId }, 'Background embedding updated');
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2025' && attempt < MAX_NOT_FOUND_RETRIES - 1) {
          logger.warn(
            { jobId: contextJobId, storyId, attempt },
            'Story not yet visible — retrying'
          );
          await sleep(NOT_FOUND_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    // H19: Classify the error. Retriable failures (429/5xx/network/timeout)
    // are rethrown so BullMQ's documented `attempts: 3` retry policy actually
    // executes — the previous catch-all swallowed everything, so a momentary
    // AI 429 permanently DLQ'd the job on the first attempt. Only permanent
    // failures (missing story row after retries, malformed response) go
    // straight to the DLQ.
    if (isRetriableError(err)) {
      logger.warn({ jobId: contextJobId, storyId, err }, 'Background embedding job failed with retriable error — rethrowing for BullMQ retry');
      throw err;
    }
    logger.warn({ jobId: contextJobId, storyId, err }, 'Background embedding job failed permanently — story will have null embedding');
    await addBackgroundDlqEntry({
      queue: 'background-embedding',
      jobId: contextJobId,
      storyId,
      failedAt: new Date().toISOString(),
      reason: (err as Error).message ?? 'unknown',
    }).catch((dlqErr) =>
      logger.error({ dlqErr }, 'Failed to enqueue background embedding failure to DLQ')
    );
  }
}

/** H19: shared error listener so background workers can't crash the process. */
function attachWorkerErrorLogging(worker: Worker, name: string): void {
  worker.on('error', (err) => {
    if (err.message?.includes('could not renew lock for job')) {
      logger.debug({ err, worker: name }, 'Lock renewal error (non-fatal, job will retry)');
      return;
    }
    if (err.message?.includes('Missing key for job') || err.message?.includes('Missing lock for job')) {
      logger.debug({ err, worker: name }, 'BullMQ lock race (non-fatal)');
      return;
    }
    logger.error({ err, worker: name }, 'Background worker error');
  });
}

export function createBackgroundEmbeddingWorker(): Worker<BackgroundEmbeddingJobData> {
  // Fix: lockDuration must exceed the background job's actual execution time
  // plus the watchdog timeout. The embedding job uses a 60s watchdog timeout.
  // BullMQ must renew the lock before lockDuration/2 elapses. Setting
  // lockDuration to 120s gives 60s between renewals, enough for the expected
  // ~60s job duration. Previously set to 30s, which caused false stall detection
  // when the lock renewal timer was starved under main-thread pressure.
  const LOCK_DURATION = parseInt(process.env.BACKGROUND_LOCK_DURATION_MS || '120000', 10);
  const worker = new Worker<BackgroundEmbeddingJobData>(
    'background-embedding',
    async (job: Job<BackgroundEmbeddingJobData>) => {
      await processEmbeddingJob(job);
    },
    {
      connection: getConnectionConfig(),
      concurrency: 2,
      lockDuration: LOCK_DURATION,
    }
  );
  attachWorkerErrorLogging(worker, 'background-embedding');
  return worker;
}