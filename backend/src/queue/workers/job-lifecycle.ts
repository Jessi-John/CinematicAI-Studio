/**
 * L4-WORKER-LIFECYCLE: deterministic BullMQ job lifecycle instrumentation.
 *
 * The worker factory is the only place that sees BullMQ lifecycle events
 * (`completed`, `failed`), so it owns the metrics. This module extracts the
 * observation logic into a pure, testable unit and makes the metric counters
 * the single source of truth for job outcomes.
 *
 * Rules:
 *   - `started` is recorded when the worker begins processing a job.
 *   - `retry` is recorded on every failed attempt that will be retried.
 *   - `completed` / `failed` / `cancelled` are recorded only on terminal
 *     outcomes (after all retries are exhausted).
 *   - Duration is observed for every terminal outcome using BullMQ's own
 *     `processedOn`/`finishedOn` timestamps when available.
 */
import type { Job } from 'bullmq';
import { jobsTotal, jobDuration, jobAttemptsTotal } from './worker-metrics.js';
import { logger } from '../../services/logger.js';
import type { StoryJobData } from '../index.js';

export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled';

/**
 * Error type used when a job is intentionally aborted (e.g., by an admin
 * cancel endpoint or by a watchdog cancellation). The worker factory records
 * these as `cancelled` rather than `failed`.
 */
export class CancelledError extends Error {
  readonly cancelled = true;
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

function isCancelledError(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && (err as { cancelled?: boolean }).cancelled === true);
}

function jobDurationSeconds(job: Job<StoryJobData>): number {
  const startMs = job.processedOn ?? job.timestamp ?? Date.now();
  const endMs = job.finishedOn ?? Date.now();
  return Math.max(0, (endMs - startMs) / 1000);
}

function safeObserve(operation: () => void, context: Record<string, unknown>): void {
  try {
    operation();
  } catch (metricsErr) {
    logger.warn({ ...context, err: metricsErr }, 'Failed to observe job lifecycle metrics');
  }
}

export function observeJobStarted(job: Job<StoryJobData>): void {
  safeObserve(() => jobAttemptsTotal.inc({ status: 'started' }), { jobId: job.id });
}

export function observeJobRetry(job: Job<StoryJobData>): void {
  safeObserve(() => jobAttemptsTotal.inc({ status: 'retry' }), { jobId: job.id });
}

export function observeJobTerminal(job: Job<StoryJobData>, status: TerminalJobStatus): void {
  safeObserve(() => {
    jobsTotal.inc({ status });
    jobDuration.observe({ status }, jobDurationSeconds(job));
  }, { jobId: job.id, status });
}

export function observeJobFailed(job: Job<StoryJobData>, err: unknown): void {
  const status = isCancelledError(err) ? 'cancelled' : 'failed';
  observeJobTerminal(job, status);
}
