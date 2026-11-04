import { describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { StoryJobData } from '../index.js';
import {
  observeJobStarted,
  observeJobRetry,
  observeJobTerminal,
  observeJobFailed,
  CancelledError,
} from './job-lifecycle.js';
import { workerRegistry } from './worker-metrics.js';

interface HistogramHash {
  labels: Record<string, string>;
  bucketValues: Record<string, number>;
  sum: number;
  count: number;
}

function makeJob(overrides: {
  processedOn?: number;
  finishedOn?: number;
  timestamp?: number;
  attemptsMade?: number;
  attempts?: number;
} = {}): Job<StoryJobData> {
  const now = Date.now();
  return {
    id: 'job-1',
    name: 'story-generation',
    timestamp: overrides.timestamp ?? now - 60_000,
    processedOn: overrides.processedOn ?? now - 50_000,
    finishedOn: overrides.finishedOn ?? now,
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 3,
    data: { jobId: 'job-1', genre: ['fantasy'], addedAt: now - 60_000 },
  } as Job<StoryJobData>;
}

function counterValue(name: string, labels: Record<string, string>): number {
  const metric = workerRegistry.getSingleMetric(name);
  if (!metric) return 0;
  const hash = (metric as unknown as { hashMap: Record<string, { value: number }> }).hashMap;
  const key = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',') + ',';
  return hash[key]?.value ?? 0;
}

describe('job lifecycle metrics', () => {
  beforeEach(() => {
    workerRegistry.resetMetrics();
  });

  it('records a started attempt', () => {
    observeJobStarted(makeJob());
    expect(counterValue('cinematicai_job_attempts_total', { status: 'started' })).toBe(1);
  });

  it('records a retry attempt', () => {
    observeJobRetry(makeJob({ attemptsMade: 1, attempts: 3 }));
    expect(counterValue('cinematicai_job_attempts_total', { status: 'retry' })).toBe(1);
  });

  it('records a completed job and observes duration', () => {
    const job = makeJob({ processedOn: Date.now() - 30_000, finishedOn: Date.now() });
    observeJobTerminal(job, 'completed');
    expect(counterValue('cinematicai_jobs_total', { status: 'completed' })).toBe(1);
    const durationMetric = workerRegistry.getSingleMetric('cinematicai_job_duration_seconds') as unknown as { hashMap: Record<string, HistogramHash> };
    const observed = Object.values(durationMetric.hashMap).find((h) => h.labels.status === 'completed');
    expect(observed?.sum).toBeGreaterThanOrEqual(25);
    expect(observed?.sum).toBeLessThanOrEqual(40);
  });

  it('records a failed terminal job', () => {
    observeJobFailed(makeJob(), new Error('boom'));
    expect(counterValue('cinematicai_jobs_total', { status: 'failed' })).toBe(1);
    expect(counterValue('cinematicai_jobs_total', { status: 'cancelled' })).toBe(0);
  });

  it('records a cancelled job when CancelledError is thrown', () => {
    observeJobFailed(makeJob(), new CancelledError('admin cancel'));
    expect(counterValue('cinematicai_jobs_total', { status: 'cancelled' })).toBe(1);
    expect(counterValue('cinematicai_jobs_total', { status: 'failed' })).toBe(0);
  });

  it('records a cancelled job when error has cancelled flag', () => {
    const err = new Error('watchdog abort');
    (err as { cancelled?: boolean }).cancelled = true;
    observeJobFailed(makeJob(), err);
    expect(counterValue('cinematicai_jobs_total', { status: 'cancelled' })).toBe(1);
  });

  it('clamps negative durations to zero', () => {
    const job = makeJob({ processedOn: Date.now(), finishedOn: Date.now() - 1000 });
    observeJobTerminal(job, 'completed');
    const durationMetric = workerRegistry.getSingleMetric('cinematicai_job_duration_seconds') as unknown as { hashMap: Record<string, HistogramHash> };
    const observed = Object.values(durationMetric.hashMap).find((h) => h.labels.status === 'completed');
    expect(observed?.sum).toBe(0);
  });

  it('falls back to timestamp when processedOn is missing', () => {
    const job = makeJob({ finishedOn: Date.now() });
    observeJobTerminal(job, 'completed');
    expect(counterValue('cinematicai_jobs_total', { status: 'completed' })).toBe(1);
  });

  it('is safe to call concurrently without crashing', () => {
    const jobs = Array.from({ length: 50 }, (_, i) => makeJob({ processedOn: Date.now() - i * 100 }));
    jobs.forEach((job) => observeJobTerminal(job, 'completed'));
    expect(counterValue('cinematicai_jobs_total', { status: 'completed' })).toBe(50);
  });
});
