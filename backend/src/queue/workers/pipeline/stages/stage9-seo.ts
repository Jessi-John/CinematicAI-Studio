/**
 * Stage 9: YouTube SEO generation.
 *
 * Generates the YouTube title / description / tags / hook script / etc.
 * BUG-005 / REL-006: hard wall-clock timeout via the worker-thread watchdog.
 * The previous JS-level `setTimeout(180_000)` did NOT fire when the main
 * thread was saturated (observed 2+ hour stalls). The watchdog runs in a
 * dedicated worker thread so it fires regardless of the main loop.
 *
 * If the call fails for any reason, populate a default YouTubeSEO so the
 * persisted row's SEO columns are never NULL.
 */

import type { StageContext, StageHelpers } from '../types.js';
import { generateYouTubeSEO, getDefaultYouTubeSEO } from '../../../../lib/ai-client.js';
import { startWatchdog } from '../../../../lib/watchdog.js';
import { logFallback } from '../../../../services/generation-logger.js';
import { EPISODES_PER_STORY } from '../../../../lib/timing.js';
import { logger } from '../../../../services/logger.js';

const SEO_STAGE_TIMEOUT_MS = 180_000; // 3 minutes wall-clock

export async function stage9Seo(
  ctx: StageContext,
  { progressEmit }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'seo', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  await progressEmit(90, 'seo', 'Generating YouTube SEO...');
  const story = ctx.story!;
  const seoWatchdog = startWatchdog({
    timeoutMs: SEO_STAGE_TIMEOUT_MS,
    label: 'stage9_SEO',
    jobId: ctx.jobId,
  });
  let timeoutPromise: Promise<never> | null = null;
  // Use the watchdog's fired promise as the timeout. If the main thread is
  // busy, the watchdog worker thread still fires after the deadline.
  timeoutPromise = seoWatchdog.fired.then((r) => {
    if (r.reason === 'timeout') {
      throw new Error(
        `SEO stage watchdog fired after ${Math.round(r.elapsedMs)}ms ` +
          `(limit ${SEO_STAGE_TIMEOUT_MS}ms)`
      );
    }
    // cancelled: never thrown — only used as a race sentinel
    return undefined as never;
  });
  try {
    const seoPromise = generateYouTubeSEO(
      story.title,
      ctx.primaryGenre,
      ctx.blueprint!.protagonistName,
      ctx.episodes?.[0]?.hook || 'Watch this story',
      ctx.episodes?.length ?? EPISODES_PER_STORY
    );
    story.youtubeSeo = await Promise.race([seoPromise, timeoutPromise]);
    const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
    logger.info(
      {
        jobId: ctx.jobId,
        requestId: ctx.requestId,
        stage: 'seo',
        elapsedMs: Math.round(elapsedMs),
        title: story.youtubeSeo?.title?.slice(0, 100),
      },
      'STAGE_COMPLETED'
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
    logger.warn(
      {
        jobId: ctx.jobId,
        requestId: ctx.requestId,
        stage: 'seo',
        elapsedMs: Math.round(elapsedMs),
        err: errMsg,
      },
      'STAGE_FAILED'
    );
    await logFallback('youtube_seo', errMsg, story.title || 'Untitled');
    // BUG-005: ensure the persisted story always has a non-null YouTubeSEO
    // package. If the AI call failed AND the inner catch in generateYouTubeSEO
    // never ran (because the hard timeout fired first), the field is still
    // undefined. Populate it with the default SEO so the row's SEO columns are
    // not NULL. The downstream createStory() persists these into the
    // youtubeTitle/youtubeDescription/youtubeTags denormalized columns.
    if (!story.youtubeSeo) {
      story.youtubeSeo = getDefaultYouTubeSEO(
        story.title,
        ctx.primaryGenre,
        ctx.episodes?.[0]?.hook || 'Watch this story'
      );
    }
  } finally {
    seoWatchdog.cancel();
  }
}
