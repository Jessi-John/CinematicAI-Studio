/**
 * Background SEO worker — runs after story creation.
 * Generates YouTube SEO via AI and upserts the youtube_seo record.
 *
 * Fix #14: Use worker-thread watchdog for the timeout, not a JS-level
 * `Promise.race` against `setTimeout`. Under main-thread event-loop
 * saturation the JS timer never fires, so the SEO job can hang far
 * beyond its 3-minute budget. The watchdog runs in a separate thread.
 *
 * Fix #29: Failed jobs are enqueued to a dedicated `background-dlq` so
 *   an operator can see them in the admin UI. Without this, a failed
 *   SEO silently left the default placeholder SEO in place and the
 *   only signal was a `WARN` log line.
 *
 * Fix #35: Race-on-startup retry. The main pipeline enqueues this job
 *   immediately after `createStory()` commits, but the in-process
 *   worker in `run-worker.ts` can pick up the job before the create
 *   transaction's row becomes visible to a separate connection. We
 *   retry on `P2025` (record not found) up to 3 times with backoff.
 */

import { Worker, type Job } from 'bullmq';
import { prisma } from '../../database/prisma.js';
import { getConnectionConfig } from '../index.js';
import { generateYouTubeSEO, runWithAIPipelineContext } from '../../lib/ai-client.js';
import { withWallClockTimeout } from '../../lib/watchdog.js';
import { logger } from '../../services/logger.js';
import { sleep } from '../../lib/sleep.js';
import { addBackgroundDlqEntry } from '../index.js';
import { isRetriableError } from '../../lib/retry.js';
import type { BackgroundSeoJobData } from '../index.js';

const SEO_TIMEOUT_MS = 180_000; // 3 minutes
const MAX_NOT_FOUND_RETRIES = 3;
const NOT_FOUND_RETRY_DELAY_MS = 500;

export async function processSeoJob(job: Job<BackgroundSeoJobData>): Promise<void> {
  const { storyId, storyTitle, genre, protagonistName, episodeHook, episodeCount } = job.data;
  const contextJobId = job.id ?? `seo-${storyId}`;
  logger.info({ jobId: contextJobId, storyId }, 'Processing background SEO job');

  try {
    const seo = await withWallClockTimeout(
      runWithAIPipelineContext(contextJobId, null, () =>
        generateYouTubeSEO(storyTitle, genre, protagonistName, episodeHook, episodeCount)
      ),
      SEO_TIMEOUT_MS,
      'background_seo',
      contextJobId
    );

    if (seo) {
      const seoData = {
        title: seo.title,
        description: seo.description,
        tags: seo.tags,
        thumbnailSuggestions: seo.thumbnailSuggestions,
        videoTemplate: seo.videoTemplate,
        hookScript: seo.hookScript,
        algorithmBoostTips: seo.algorithmBoostTips,
        viralPotential: seo.viralPotential,
        recommendedDuration: seo.recommendedDuration,
        targetAudience: seo.targetAudience,
        trendingKeywords: seo.trendingKeywords,
        ctaScript: seo.ctaScript,
      };

      // Fix #35: retry on P2025. See background-embedding.worker.ts for
      // the rationale. The youtube_seo row is created in the same
      // createStory transaction, so the race window is identical.
      for (let attempt = 0; attempt < MAX_NOT_FOUND_RETRIES; attempt++) {
        try {
          await prisma().youTubeSEO.upsert({
            where: { storyId },
            create: { storyId, ...seoData },
            update: seoData,
          });
          logger.info({ jobId: contextJobId, storyId }, 'Background SEO updated');
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
    } else {
      logger.warn({ jobId: contextJobId, storyId }, 'YouTube SEO generation returned null — writing DLQ entry');
      await addBackgroundDlqEntry({
        queue: 'background-seo',
        jobId: contextJobId,
        storyId,
        failedAt: new Date().toISOString(),
        reason: 'YouTube SEO generation returned null result',
      }).catch((dlqErr) =>
        logger.error({ dlqErr }, 'Failed to enqueue background SEO failure to DLQ')
      );
      return;
    }
  } catch (err) {
    // H19: rethrow retriable errors so BullMQ's retry policy executes; only
    // permanent failures go straight to the DLQ (mirrors embedding worker).
    if (isRetriableError(err)) {
      logger.warn({ jobId: contextJobId, storyId, err }, 'Background SEO job failed with retriable error — rethrowing for BullMQ retry');
      throw err;
    }
    logger.warn({ jobId: contextJobId, storyId, err }, 'Background SEO job failed permanently — story already has default SEO, skipping');
    await addBackgroundDlqEntry({
      queue: 'background-seo',
      jobId: contextJobId,
      storyId,
      failedAt: new Date().toISOString(),
      reason: (err as Error).message ?? 'unknown',
    }).catch((dlqErr) =>
      logger.error({ dlqErr }, 'Failed to enqueue background SEO failure to DLQ')
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

export function createBackgroundSeoWorker(): Worker<BackgroundSeoJobData> {
  // Fix: lockDuration must exceed the background job's actual execution time
  // plus the watchdog timeout. The SEO job uses a 180s watchdog timeout.
  // BullMQ must renew the lock before lockDuration/2 elapses (90s). Setting
  // lockDuration to 300s gives 150s between renewals, well above the expected
  // 180s job duration plus buffer. Previously set to 30s, which caused false
  // stall detection under main-thread pressure when the lock renewal timer
  // was starved.
  const LOCK_DURATION = parseInt(process.env.BACKGROUND_LOCK_DURATION_MS || '300000', 10);
  const worker = new Worker<BackgroundSeoJobData>(
    'background-seo',
    async (job: Job<BackgroundSeoJobData>) => {
      await processSeoJob(job);
    },
    {
      connection: getConnectionConfig(),
      concurrency: 2,
      lockDuration: LOCK_DURATION,
    }
  );
  attachWorkerErrorLogging(worker, 'background-seo');
  return worker;
}