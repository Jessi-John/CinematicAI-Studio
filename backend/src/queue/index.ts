import { Queue, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { getRedisPassword, getRedisUrl as getRedisUrlFromEnv } from '../config/env.js';
import { freshDnsLookup } from '../lib/create-redis.js';

// Lazy getter for Redis URL — evaluated lazily so it is read after
// validateAndLoadEnv() has completed. Previously, REDIS_URL was a
// module-level constant evaluated at import time, before env validation ran.
export function getRedisUrl(): string {
  return getRedisUrlFromEnv();
}

// Lazy queue initialization — queues are created on first access, not at module
// import time. This prevents BullMQ from attempting Redis connections when the
// module is loaded in test environments without Redis (chain.integration.test.ts,
// prisma-storage.test.ts, e2e/story-worker.integration.spec.ts).

// Inline types (jobs/types.ts was unused elsewhere — consolidated here)
export interface StoryJobData {
  jobId: string;
  genre: string[];
  seed?: string;
  forceNew?: boolean;
  requestId?: string;
  addedAt: number;
  webhookUrl?: string;
  storyId?: string;
  userId?: string;
  // M28: Set to true when this job is being retried from the DLQ. The pipeline
  // uses this to relax quality thresholds so the story gets a second chance
  // even if its grade is below the configured floor. See runStoryPipeline.
  retryFromDlq?: boolean;
}

export interface DlqEntry extends StoryJobData {
  _failedReason: string;
  _failedAt: number;
}

export interface JobProgress {
  jobId: string;
  type: 'progress' | 'complete' | 'error';
  progress: number;
  stage?: string;
  message?: string;
  data?: unknown;
}

export interface JobState {
  state: 'pending' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress: number;
  data?: unknown;
}

// Lazy getters for Redis connection — these are evaluated lazily so they
// are read after validateAndLoadEnv() has completed. Previously, REDIS_URL
// and connectionConfig were module-level constants evaluated at import time,
// before server.ts called loadEnvFiles(). In standalone tsx dev without Docker,
// the .env values were missed and fallback redis://localhost:6379 was used.
// The same lazy pattern is already used by getStoryQueue(), getStoryDlq(), etc.
export function getConnectionConfig() {
  return {
    url: getRedisUrl(),
    password: getRedisPassword(),
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
    dnsLookup: freshDnsLookup,
  };
}

export function getWorkerLockDuration(): number {
  const parsed = parseInt(process.env.WORKER_LOCK_DURATION_MS || '60000', 10);
  return Number.isFinite(parsed) ? parsed : 60000;
}

export function getWorkerLockRenewTime(): number {
  const parsed = parseInt(process.env.WORKER_LOCK_RENEW_TIME_MS || '20000', 10);
  return Number.isFinite(parsed) ? parsed : 20000;
}

export const workerConfig = {
  get lockDuration(): number { return getWorkerLockDuration(); },
  get lockRenewTime(): number { return getWorkerLockRenewTime(); },
};

// Fix #30: Story pipeline retry and cleanup policy, consolidated into one place.
// These are the single source of truth for both queue defaults and per-job options.

// Retry policy rationale:
//   attempts: 3  — initial attempt + 2 retries. A story pipeline runs 15-25 min,
//                  so 3 total attempts (7s max on exponential backoff) is a
//                  deliberate choice: transient failures (brief network blip,
//                  momentary DB pressure) get a quick retry; persistent failures
//                  (bad prompt, quality rejection, AI outage) fail fast rather than
//                  burning the full pipeline time on each attempt.
//   backoff: exponential, delay: 1000 — 1 s → 2 s → 4 s. Short enough that a
//                  legitimately transient failure recovers within seconds; long
//                  enough that a brief Redis/DB hiccup clears before the next try.
//                  10 × multiplier cap prevents unbounded delay.
//
// Cleanup policy:
//   removeOnComplete { age: 3600, count: 100 } — completed jobs are auto-removed
//                  after 1 hour. The pipeline result is already in PostgreSQL, so
//                  keeping the Redis job around beyond an hour adds no value.
//   removeOnFail { age: 86400, count: 100 } — failed jobs stay in Redis for 24 h
//                  so operators can inspect job state via BullMQ dashboard during
//                  the investigation window. They are NOT the long-term record;
//                  the DLQ is (7-day TTL, see below).
export const STORY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86400, count: 100 },
} as const;

// Dead Letter Queue — failed jobs are manually added here after all retries are
// exhausted. The authoritative path is the worker's `failed` event (worker-factory.ts).
// The DLQ survives beyond the main queue's removeOnFail window:
//   removeOnFail { age: 604800 } — 7 days, giving operators a full week to inspect
//   failed entries before they auto-expire from Redis. This is intentionally longer
//   than the 24 h main-queue window because DLQ inspection is async and often
//   batched (e.g., morning oncall review).
let _storyDlq: Queue<DlqEntry> | null = null;
let _storyQueue: Queue<StoryJobData> | null = null;

export function getStoryDlq(): Queue<DlqEntry> {
  if (!_storyDlq) {
    _storyDlq = new Queue<DlqEntry>('story-generation-dlq', {
      connection: getConnectionConfig(),
      defaultJobOptions: {
        removeOnFail: { age: 604800 }, // 7 days
      },
    });
  }
  return _storyDlq;
}

export function getStoryQueue(): Queue<StoryJobData> {
  if (!_storyQueue) {
    _storyQueue = new Queue<StoryJobData>('story-generation', {
      connection: getConnectionConfig(),
      defaultJobOptions: STORY_JOB_OPTIONS,
    });
  }
  return _storyQueue;
}

// Backwards-compatible named exports for existing consumers.
// The Proxy wraps lazy getters in try-catch so that if BullMQ throws during
// Queue construction (e.g. Redis unavailable in test env), the error is caught
// and a no-op mock is returned instead of crashing the process at import time.
// In production, errors are surfaced so the admin dashboard shows the real queue state.
const isTestEnv = process.env.NODE_ENV === 'test';
// LOW #60: The Proxy target is typed directly so we avoid an `as unknown as`
// cast. The proxy itself only forwards property access to the lazy Queue
// instance (or a no-op mock in test environments).
const proxyTarget = Object.create(null);
export const storyDlq: Queue<DlqEntry> = new Proxy(proxyTarget, {
  get(_target, prop) {
    try {
      return Reflect.get(getStoryDlq(), prop);
    } catch (err) {
      if (!isTestEnv) throw err;
      return noOpQueue()[prop as keyof ReturnType<typeof noOpQueue>];
    }
  },
});

export const storyQueue: Queue<StoryJobData> = new Proxy(proxyTarget, {
  get(_target, prop) {
    try {
      return Reflect.get(getStoryQueue(), prop);
    } catch (err) {
      if (!isTestEnv) throw err;
      return noOpQueue()[prop as keyof ReturnType<typeof noOpQueue>];
    }
  },
});

// No-op queue mock returned when BullMQ can't connect (test environments).
// Provides the minimal interface that consumers need without requiring Redis.
function noOpQueue(): Record<string, unknown> {
  return {
    add: async () => ({ id: 'mock-job' }),
    getJob: async () => undefined,
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }),
    getJobs: async () => [],
    close: async () => {},
  };
}

export interface AddStoryJobInput {
  genre: string[];
  seed?: string;
  forceNew?: boolean;
  requestId?: string;
  webhookUrl?: string;
}

const MAX_GENRES = 5;
const MAX_SEED_LENGTH = 2000;
const MAX_WEBHOOK_URL_LENGTH = 2048;

function validateStoryJobInput(data: AddStoryJobInput): void {
  if (!Array.isArray(data.genre) || data.genre.length === 0 || data.genre.length > MAX_GENRES) {
    throw new Error(`Invalid genre count: must be 1-${MAX_GENRES}`);
  }
  if (data.seed !== undefined && data.seed.length > MAX_SEED_LENGTH) {
    throw new Error(`Seed exceeds maximum length of ${MAX_SEED_LENGTH}`);
  }
  if (data.webhookUrl !== undefined && data.webhookUrl.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new Error(`webhookUrl exceeds maximum length of ${MAX_WEBHOOK_URL_LENGTH}`);
  }
}

export async function addStoryJob(data: AddStoryJobInput): Promise<Job<StoryJobData>> {
  validateStoryJobInput(data);
  const sq = getStoryQueue();
  const jobId = data.requestId || randomUUID();
  return sq.add('generate', { ...data, jobId, addedAt: Date.now() }, {
    jobId,
    ...STORY_JOB_OPTIONS,
  });
}

export async function getJobStatus(jobId: string): Promise<{
  state: string;
  progress: number;
  stage?: string;
  message?: string;
  error?: string;
  data?: unknown;
}> {
  const sq = getStoryQueue();
  const job = await sq.getJob(jobId);
  if (!job) return { state: 'unknown', progress: 0 };
  const state = await job.getState();
  const progress = typeof job.progress === 'number' ? job.progress : 0;
  // Surface stage/message from job.data (set by story.worker.ts safeSetState)
  type StoryJobDataWithState = StoryJobData & { stage?: string; message?: string };
  const jobData = job.data as StoryJobDataWithState | undefined;
  const stage = typeof jobData?.stage === 'string' ? jobData.stage : undefined;
  const message = typeof jobData?.message === 'string' ? jobData.message : undefined;
  const error = state === 'failed' && job.failedReason ? job.failedReason : undefined;
  return {
    state,
    progress,
    ...(stage !== undefined ? { stage } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(error !== undefined ? { error } : {}),
    // Only expose public metadata from job data; never leak webhookUrl,
    // userId, or other internal fields to status consumers.
    data: { stage, message, error, storyId: jobData?.storyId },
  };
}

export async function closeQueues(): Promise<void> {
  // M19: null out the lazy singletons after close — previously getStoryQueue()
  // returned a CLOSED Queue after closeQueues(), and any subsequent add()
  // threw a confusing ioredis error.
  if (_storyQueue) await _storyQueue.close();
  if (_storyDlq) await _storyDlq.close();
  if (_backgroundSeoQueue) await _backgroundSeoQueue.close();
  if (_backgroundEmbeddingQueue) await _backgroundEmbeddingQueue.close();
  if (_backgroundDlq) await _backgroundDlq.close();
  _storyQueue = null;
  _storyDlq = null;
  _backgroundSeoQueue = null;
  _backgroundEmbeddingQueue = null;
  _backgroundDlq = null;
}

export async function closeDlq(): Promise<void> {
  if (_storyDlq) await _storyDlq.close();
}

// ---------- Background job types ----------

export interface BackgroundSeoJobData {
  storyId: string;
  storyTitle: string;
  genre: string;
  protagonistName: string;
  episodeHook: string;
  episodeCount: number;
}

export interface BackgroundEmbeddingJobData {
  storyId: string;
  conceptText: string;
}

// Fix #29: Background DLQ entry. Failed background jobs (SEO/embedding)
// are enqueued here so the admin UI can list them. The shape is
// deliberately minimal — we only need enough to identify the failure
// and the offending story, not to replay the job.
export interface BackgroundDlqEntry {
  queue: 'background-seo' | 'background-embedding';
  jobId: string;
  storyId: string;
  failedAt: string;
  reason: string;
}

// ---------- Background queues ----------

// Background job retry policy — intentionally more conservative than the main
// story pipeline because background SEO/embedding are non-critical and should
// not hammer the AI API during an outage.
//   attempts: 3  — 2 retries. Background work is best-effort but transient
//                  failures (Redis hiccup, AI 429) should get a second chance.
//   backoff: 2000 ms — longer than the main pipeline's 1000 ms, reflecting that
//                  background work is less latency-sensitive.
//   removeOnComplete/Fail count: 50 — half the main pipeline's 100, since
//                  background jobs are smaller and less worth keeping around.
export const BACKGROUND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 50 },
  removeOnFail: { age: 86400, count: 50 },
} as const;

let _backgroundSeoQueue: Queue<BackgroundSeoJobData> | null = null;
let _backgroundEmbeddingQueue: Queue<BackgroundEmbeddingJobData> | null = null;
let _backgroundDlq: Queue<BackgroundDlqEntry> | null = null;

export function getBackgroundSeoQueue(): Queue<BackgroundSeoJobData> {
  if (!_backgroundSeoQueue) {
    _backgroundSeoQueue = new Queue<BackgroundSeoJobData>('background-seo', {
      connection: getConnectionConfig(),
      defaultJobOptions: BACKGROUND_JOB_OPTIONS,
    });
  }
  return _backgroundSeoQueue;
}

export function getBackgroundEmbeddingQueue(): Queue<BackgroundEmbeddingJobData> {
  if (!_backgroundEmbeddingQueue) {
    _backgroundEmbeddingQueue = new Queue<BackgroundEmbeddingJobData>('background-embedding', {
      connection: getConnectionConfig(),
      defaultJobOptions: BACKGROUND_JOB_OPTIONS,
    });
  }
  return _backgroundEmbeddingQueue;
}

export function getBackgroundDlq(): Queue<BackgroundDlqEntry> {
  if (!_backgroundDlq) {
    _backgroundDlq = new Queue<BackgroundDlqEntry>('background-dlq', {
      connection: getConnectionConfig(),
      defaultJobOptions: {
        removeOnFail: { age: 604800 }, // 7 days, same as the main DLQ
      },
    });
  }
  return _backgroundDlq;
}

export async function addBackgroundSeoJob(data: BackgroundSeoJobData): Promise<Job<BackgroundSeoJobData>> {
  return getBackgroundSeoQueue().add('seo', data, { jobId: `seo-${data.storyId}-${Date.now()}` });
}

export async function addBackgroundEmbeddingJob(data: BackgroundEmbeddingJobData): Promise<Job<BackgroundEmbeddingJobData>> {
  return getBackgroundEmbeddingQueue().add('embedding', data, { jobId: `emb-${data.storyId}-${Date.now()}` });
}

export async function addBackgroundDlqEntry(entry: BackgroundDlqEntry): Promise<Job<BackgroundDlqEntry>> {
  return getBackgroundDlq().add('background-failed', entry, {
    jobId: `bdlq-${entry.queue}-${entry.storyId}-${Date.now()}`,
  });
}

export async function closeBackgroundQueues(): Promise<void> {
  if (_backgroundSeoQueue) await _backgroundSeoQueue.close();
  if (_backgroundEmbeddingQueue) await _backgroundEmbeddingQueue.close();
  if (_backgroundDlq) await _backgroundDlq.close();
}
