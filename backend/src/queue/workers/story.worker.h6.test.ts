/**
 * H6 regression: a failed job attempt must NOT emit a terminal 'error' SSE
 * event (which tears down the client stream) until all BullMQ attempts are
 * exhausted. Non-terminal attempts emit a 'retrying' progress event instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mocks = vi.hoisted(() => ({
  publishProgress: vi.fn().mockResolvedValue(undefined),
  setJobState: vi.fn().mockResolvedValue(undefined),
  getJobState: vi.fn().mockResolvedValue(null),
  markJobFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../redis-pubsub.js', () => ({
  publishProgress: mocks.publishProgress,
  setJobState: mocks.setJobState,
  getJobState: mocks.getJobState,
  markJobFailed: mocks.markJobFailed,
}));

vi.mock('./pipeline/index.js', () => ({
  runStoryPipeline: vi.fn().mockRejectedValue(new Error('transient provider failure')),
  __resetDeathLoopGuard: vi.fn(),
}));

vi.mock('../../database/prisma.js', () => ({
  prisma: () => ({}),
  __setClient: vi.fn(),
}));

vi.mock('../../services/token-budget.js', () => ({
  refundTokenBudget: vi.fn().mockResolvedValue(undefined),
  clearTokenSpend: vi.fn(),
}));

vi.mock('../../services/webhook.js', () => ({
  callWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processStoryJob } from './story.worker.js';

function makeJob(attemptsMade: number, attempts: number): Job {
  return {
    id: 'job-h6',
    attemptsMade,
    opts: { attempts },
    data: { jobId: 'job-h6', genre: ['fantasy'], seed: 'test seed' },
  } as unknown as Job;
}

describe('H6 — terminal error only on final attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishProgress.mockResolvedValue(undefined);
    mocks.getJobState.mockResolvedValue(null);
  });

  it('non-terminal failure emits retrying progress, not a terminal error', async () => {
    await expect(processStoryJob(makeJob(1, 3))).rejects.toThrow('transient provider failure');

    const types = mocks.publishProgress.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('error');
    expect(types).toContain('progress');
    const retryEvents = mocks.publishProgress.mock.calls.filter(
      (c) => (c[0] as { stage?: string }).stage === 'retrying'
    );
    expect(retryEvents.length).toBe(1);
    expect(mocks.markJobFailed).not.toHaveBeenCalled();
  });

  it('terminal failure emits error and marks the job failed', async () => {
    await expect(processStoryJob(makeJob(3, 3))).rejects.toThrow('transient provider failure');

    const types = mocks.publishProgress.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('error');
    expect(mocks.markJobFailed).toHaveBeenCalledTimes(1);
  });
});
