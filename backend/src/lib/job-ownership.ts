/**
 * Per-user job ownership resolution (H1 — SSE/status IDOR fix).
 *
 * The SSE (`/events`) and `/status` endpoints historically accepted ANY valid
 * JWT and returned the target job's stream/status without checking that the
 * caller actually owns that job. Because jobIds are sequential/observable, any
 * authenticated user could subscribe to another user's generation stream
 * (leaking prompts, story content, webhook targets) or poll its status.
 *
 * This module resolves the owning userId for a job and lets the auth middleware
 * enforce "JWT subject === job owner" before granting access.
 *
 * Resolution order (most authoritative first):
 *   1. job.data.userId — set synchronously at enqueue by the generate route
 *      (which requires JWT auth), so every live job carries its owner's id.
 *   2. The persisted story row via job.data.storyId — covers completed jobs
 *      whose queue entry still exists (userId may be absent on legacy data).
 *   3. The Redis job state userId (7-day TTL, written by the worker) — covers
 *      the post-completion window after the queue entry is removed
 *      (removeOnComplete), letting a reconnecting SSE client still authorize.
 *
 * If none of these resolve, ownership is unknown and callers MUST fail closed.
 */

import { getStoryQueue } from '../queue/index.js';
import { prisma } from '../database/prisma.js';
import { getJobState } from '../queue/redis-pubsub.js';
import { logger } from '../services/logger.js';

/**
 * Resolve the owning userId for a story-generation job, or null when it cannot
 * be determined (job never existed, or it is older than every store's
 * retention window).
 */
export async function getJobOwnerId(jobId: string): Promise<string | null> {
  try {
    const job = await getStoryQueue().getJob(jobId);
    const jobUserId = job?.data?.userId as string | undefined;
    if (typeof jobUserId === 'string' && jobUserId.length > 0) return jobUserId;

    // Completed jobs: fall back to the persisted story's owner.
    const storyId = job?.data?.storyId as string | undefined;
    if (typeof storyId === 'string' && storyId.length > 0) {
      const story = await prisma().story.findUnique({
        where: { id: storyId },
        select: { userId: true },
      });
      if (typeof story?.userId === 'string' && story.userId.length > 0) return story.userId;
    }
  } catch (err) {
    logger.warn({ jobId, err: String(err) }, 'getJobOwnerId: queue/story lookup failed');
  }

  try {
    const state = await getJobState(jobId);
    const stateUserId = state?.userId as string | undefined;
    if (typeof stateUserId === 'string' && stateUserId.length > 0) return stateUserId;
  } catch (err) {
    logger.warn({ jobId, err: String(err) }, 'getJobOwnerId: job-state lookup failed');
  }

  return null;
}

/**
 * Verify the given user owns the job. Fail-closed: when ownership cannot be
 * resolved (null owner) or the caller has no id, this returns false so a job
 * whose owner is unknown is never exposed.
 */
export async function userOwnsJob(
  jobId: string,
  userId: string | undefined
): Promise<boolean> {
  if (typeof userId !== 'string' || userId.length === 0) return false;
  const ownerId = await getJobOwnerId(jobId);
  if (ownerId === null) return false;
  return ownerId === userId;
}
