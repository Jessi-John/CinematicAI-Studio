/**
 * Queue module unit tests — MEDIUM #48.
 *
 * Covers lazy queue creation, the test-env proxy fallback, addStoryJob
 * defaults, getJobStatus, and closeQueues.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface QueueMock {
  name: string;
  add: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const queueMocks: QueueMock[] = [];

function makeQueueMock(name: string): QueueMock {
  const q: QueueMock = {
    name,
    add: vi.fn().mockResolvedValue({ id: `${name}-job` }),
    getJob: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  queueMocks.push(q);
  return q;
}

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function QueueConstructor(name: string) {
    return makeQueueMock(name);
  }),
}));

vi.mock('../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  getRedisPassword: () => undefined,
  getRedisUrl: () => 'redis://localhost:6379',
  allowInsecureLocalHttp: () => false,
  isRegistrationDisabled: () => false,
  getInviteCode: () => undefined,
  getMaxConcurrentGenerations: () => 0,
  getMaxStoriesPerDay: () => 0,
  getDailySpendCapUsd: () => 0,
  getMonthlySpendCapUsd: () => 0,
  getBackupS3Bucket: () => undefined,
  getBackupS3Prefix: () => 'cinematicai-backups',
  getAlertWebhookUrl: () => undefined,
}));

vi.mock('../lib/create-redis.js', () => ({
  freshDnsLookup: vi.fn(),
}));

describe('queue/index', () => {
  let QueueMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const bullmq = await import('bullmq');
    QueueMock = bullmq.Queue as unknown as ReturnType<typeof vi.fn>;
    QueueMock.mockClear();
    queueMocks.length = 0;
  });

  it('creates queues lazily on first access', async () => {
    const queue = await import('./index.js');

    expect(QueueMock).not.toHaveBeenCalled();

    queue.getStoryQueue();
    expect(QueueMock).toHaveBeenCalledTimes(1);
    expect(QueueMock).toHaveBeenCalledWith(
      'story-generation',
      expect.objectContaining({
        defaultJobOptions: expect.objectContaining({ attempts: 3 }),
      })
    );

    queue.getStoryDlq();
    expect(QueueMock).toHaveBeenCalledTimes(2);
    expect(QueueMock).toHaveBeenLastCalledWith(
      'story-generation-dlq',
      expect.any(Object)
    );
  });

  it('proxy returns a no-op queue in test env when BullMQ throws', async () => {
    QueueMock.mockImplementation(function ThrowingQueueConstructor() {
      throw new Error('Redis connection failed');
    });

    try {
      const queue = await import('./index.js');
      const addResult = await queue.storyQueue.add('generate', { genre: ['fantasy'] } as unknown as import('./index.js').StoryJobData);
      const job = await queue.storyQueue.getJob('any-id');

      expect(addResult).toEqual({ id: 'mock-job' });
      expect(job).toBe(undefined);
    } finally {
      QueueMock.mockImplementation(function QueueConstructor(name: string) {
        return makeQueueMock(name);
      });
    }
  });

  it('addStoryJob enqueues with name "generate" and STORY_JOB_OPTIONS', async () => {
    const queue = await import('./index.js');
    const job = await queue.addStoryJob({ genre: ['scifi'], requestId: 'req-1' });

    const storyQueue = queueMocks.find((q) => q.name === 'story-generation');
    expect(storyQueue).toEqual(expect.any(Object));

    expect(storyQueue!.add).toHaveBeenCalledWith(
      'generate',
      expect.objectContaining({
        genre: ['scifi'],
        jobId: 'req-1',
        addedAt: expect.any(Number),
      }),
      expect.objectContaining({
        jobId: 'req-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: expect.any(Object),
        removeOnFail: expect.any(Object),
      })
    );
    expect(job).toEqual({ id: 'story-generation-job' });
  });

  it('getJobStatus returns unknown when the job is missing', async () => {
    const queue = await import('./index.js');
    const status = await queue.getJobStatus('missing-id');

    expect(status).toEqual({ state: 'unknown', progress: 0 });
  });

  it('getJobStatus returns state, progress, stage and message for an existing job', async () => {
    const queue = await import('./index.js');
    queue.getStoryQueue();
    const storyQueue = queueMocks.find((q) => q.name === 'story-generation');
    storyQueue!.getJob.mockResolvedValue({
      id: 'job-1',
      getState: vi.fn().mockResolvedValue('active'),
      progress: 42,
      data: { stage: 'outlining', message: 'working' },
    });

    const status = await queue.getJobStatus('job-1');

    expect(status).toEqual({
      state: 'active',
      progress: 42,
      stage: 'outlining',
      message: 'working',
      data: expect.objectContaining({ stage: 'outlining', message: 'working' }),
    });
  });

  it('getJobStatus returns failed job error reason', async () => {
    const queue = await import('./index.js');
    queue.getStoryQueue();
    const storyQueue = queueMocks.find((q) => q.name === 'story-generation');
    storyQueue!.getJob.mockResolvedValue({
      id: 'job-2',
      getState: vi.fn().mockResolvedValue('failed'),
      failedReason: 'Pipeline timed out after 2700000ms',
      progress: 0,
      data: { stage: 'error', message: 'Generation failed' },
    });

    const status = await queue.getJobStatus('job-2');

    expect(status).toEqual({
      state: 'failed',
      progress: 0,
      stage: 'error',
      message: 'Generation failed',
      error: 'Pipeline timed out after 2700000ms',
      data: expect.objectContaining({
        stage: 'error',
        message: 'Generation failed',
        error: 'Pipeline timed out after 2700000ms',
      }),
    });
  });

  it('closeQueues closes only the queues that were created', async () => {
    const queue = await import('./index.js');
    queue.getStoryQueue();
    queue.getStoryDlq();

    const storyQueue = queueMocks.find((q) => q.name === 'story-generation')!;
    const dlq = queueMocks.find((q) => q.name === 'story-generation-dlq')!;

    expect(storyQueue.close).not.toHaveBeenCalled();
    expect(dlq.close).not.toHaveBeenCalled();

    await queue.closeQueues();

    expect(storyQueue.close).toHaveBeenCalledTimes(1);
    expect(dlq.close).toHaveBeenCalledTimes(1);
  });
});
