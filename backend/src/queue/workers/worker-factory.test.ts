/**
 * Worker factory unit tests — MEDIUM #48.
 *
 * Covers Worker construction options, DLQ handling on terminal failures,
 * retry behaviour, skipDlq errors, and the error-listener noise filters.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface WorkerMock {
  name?: string;
  processor?: (job: unknown) => Promise<unknown>;
  options?: unknown;
  handlers: Record<string, Array<(...args: unknown[]) => unknown>>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const workerMocks: WorkerMock[] = [];

function makeWorkerMock(): WorkerMock {
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const worker: WorkerMock = {
    handlers,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
      return worker;
    }),
  };
  workerMocks.push(worker);
  return worker;
}

function getHandlers(w: import('bullmq').Worker<import('../index.js').StoryJobData>): WorkerMock['handlers'] {
  return (w as unknown as WorkerMock).handlers;
}

let dlqAdd: ReturnType<typeof vi.fn>;
let dlqClose: ReturnType<typeof vi.fn>;

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerConstructor(
    name: string,
    processor: (job: unknown) => Promise<unknown>,
    options: unknown
  ) {
    const worker = makeWorkerMock();
    worker.name = name;
    worker.processor = processor;
    worker.options = options;
    return worker;
  }),
  Job: class Job {},
}));

vi.mock('../index.js', () => ({
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  getStoryDlq: vi.fn(() => ({ add: dlqAdd, close: dlqClose })),
}));

vi.mock('../redis-pubsub.js', () => ({
  publishProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('./job-lifecycle.js', () => ({
  observeJobStarted: vi.fn(),
  observeJobRetry: vi.fn(),
  observeJobFailed: vi.fn(),
  observeJobTerminal: vi.fn(),
}));

vi.mock('./story.worker.js', () => ({
  processStoryJob: vi.fn().mockResolvedValue({ ok: true }),
}));

describe('worker-factory', () => {
  let WorkerMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const bullmq = await import('bullmq');
    WorkerMock = bullmq.Worker as unknown as ReturnType<typeof vi.fn>;
    WorkerMock.mockClear();
    workerMocks.length = 0;
    dlqAdd = vi.fn().mockResolvedValue({ id: 'dlq-job' });
    dlqClose = vi.fn().mockResolvedValue(undefined);

    const { publishProgress } = await import('../redis-pubsub.js');
    vi.mocked(publishProgress).mockClear();
    const { logger } = await import('../../services/logger.js');
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.debug).mockClear();
    const {
      observeJobStarted,
      observeJobRetry,
      observeJobFailed,
      observeJobTerminal,
    } = await import('./job-lifecycle.js');
    vi.mocked(observeJobStarted).mockClear();
    vi.mocked(observeJobRetry).mockClear();
    vi.mocked(observeJobFailed).mockClear();
    vi.mocked(observeJobTerminal).mockClear();
  });

  it('creates a Worker with expected concurrency, limiter and lock options', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { worker } = createStoryWorker({ concurrency: 4 });

    expect(worker).toEqual(expect.any(Object));
    expect(WorkerMock).toHaveBeenCalledWith(
      'story-generation',
      expect.any(Function),
      expect.objectContaining({
        connection: { url: 'redis://localhost:6379' },
        concurrency: 4,
        limiter: { max: expect.any(Number), duration: expect.any(Number) },
        lockDuration: 60000,
        lockRenewTime: 20000,
        stalledInterval: 300_000,
      })
    );
  });

  it('closeDlq closes the DLQ queue', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { closeDlq } = createStoryWorker();

    await closeDlq();
    expect(dlqClose).toHaveBeenCalledTimes(1);
  });

  it('failed listener retries non-terminal attempts without DLQ or error events', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { observeJobRetry } = await import('./job-lifecycle.js');
    const { publishProgress } = await import('../redis-pubsub.js');
    const { worker } = createStoryWorker();

    const job = {
      id: 'job-1',
      opts: { attempts: 3 },
      attemptsMade: 1,
      data: { jobId: 'jid-1' },
    };

    await getHandlers(worker)['failed']![0]!(job, new Error('transient'));

    expect(observeJobRetry).toHaveBeenCalledWith(job);
    expect(dlqAdd).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it('failed listener adds a DLQ entry and publishes an error progress event on terminal failure', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { observeJobFailed } = await import('./job-lifecycle.js');
    const { publishProgress } = await import('../redis-pubsub.js');
    const { worker } = createStoryWorker();

    const err = new Error('terminal failure');
    const job = {
      id: 'job-2',
      opts: { attempts: 3 },
      attemptsMade: 3,
      data: { jobId: 'jid-2', genre: ['fantasy'], addedAt: 12345 },
    };

    await getHandlers(worker)['failed']![0]!(job, err);

    expect(observeJobFailed).toHaveBeenCalledWith(job, err);
    expect(dlqAdd).toHaveBeenCalledWith(
      'failed-story',
      expect.objectContaining({
        jobId: 'jid-2',
        genre: ['fantasy'],
        addedAt: 12345,
        _failedReason: 'terminal failure',
        _failedAt: expect.any(Number),
      }),
      { jobId: 'dlq-job-2' }
    );
    expect(publishProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'jid-2',
        type: 'error',
        progress: 0,
        stage: 'error',
        message: 'Generation failed: terminal failure',
      })
    );
  });

  it('failed listener skips the DLQ for errors marked with skipDlq', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { observeJobFailed } = await import('./job-lifecycle.js');
    const { publishProgress } = await import('../redis-pubsub.js');
    const { worker } = createStoryWorker();

    const err = Object.assign(new Error('duplicate story'), { skipDlq: true });
    const job = {
      id: 'job-3',
      opts: { attempts: 3 },
      attemptsMade: 3,
      data: { jobId: 'jid-3' },
    };

    await getHandlers(worker)['failed']![0]!(job, err);

    expect(observeJobFailed).toHaveBeenCalledWith(job, err);
    expect(dlqAdd).not.toHaveBeenCalled();
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it('error listener filters lock-renewal and missing-key messages', async () => {
    const { createStoryWorker } = await import('./worker-factory.js');
    const { logger } = await import('../../services/logger.js');
    const { worker } = createStoryWorker();

    const errorHandler = getHandlers(worker)['error']![0]!;

    await errorHandler(new Error('could not renew lock for job 123'));
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    await errorHandler(new Error('Missing key for job 123 updateData'));
    expect(logger.debug).toHaveBeenCalledTimes(2);

    await errorHandler(new Error('unhandled worker error'));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Worker error'
    );
  });
});
