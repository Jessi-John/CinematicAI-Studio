// Test setup: runs once before all tests load.
// Sets required environment variables for all test files.
//
// IMPORTANT: JWT_SECRET and API_SECRET MUST be set here so they are
// available before ANY test triggers validateAndLoadEnv(). That function
// caches env values on first call — if another test triggers it first
// without JWT_SECRET set, a derived key gets cached and all subsequent
// JWT operations (sign + verify) use the wrong secret, causing 401s.
// See src/middleware/jwt.concurrent.test.ts for the original symptom.

import { vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-concurrency';
process.env.API_SECRET = 'test-api-secret-for-concurrency';
process.env.ADMIN_API_KEY = 'test_admin_key';
process.env.KIMI_API_KEY = 'test-kimi-api-key-for-testing-only-not-real';
process.env.KIMI_MODEL = 'k3';
process.env.MISTRAL_API_KEY = 'test-mistral-api-key-for-testing-only-not-real';
// Allow external DATABASE_URL/REDIS_URL overrides for live Docker DB tests.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
// PERF-BLUEPRINT-SUITE: collapse retry-backoff windows in unit tests. The
// blueprint suite spent ~52s mostly waiting on real
// `sleep(RETRY_DELAY_MS * 2^attempt)` windows in episode-generator.ts.
// lib/sleep.ts scales delays by this factor (clamped to (0,1], VITEST-only).
// Timing-sensitive tests that need real elapsed time should stub the sleep
// module themselves (vi.mock('./sleep.js')) — those stubs take precedence.
process.env.STORY_TEST_SLEEP_FACTOR = '0.01';

// LOW #54: Global silencing mocks for Redis/BullMQ imports. These prevent
// ECONNREFUSED logs from leaking into normal `npm test` output when a test
// file accidentally imports a module that touches ioredis or BullMQ at
// module-evaluation time. Test files that define their own `vi.mock` for
// these modules take precedence, so existing isolated mocks keep working.

const mockRedisClient = {
  on: vi.fn(),
  once: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue('OK'),
  ping: vi.fn().mockResolvedValue('PONG'),
  call: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  setex: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  exists: vi.fn().mockResolvedValue(0),
  eval: vi.fn().mockResolvedValue([1, 0, 0, 'ok']),
  // M36: token-budget circuit-breaker paths (_getBreakerState/_setBreakerState)
  // and concept-registry SCAN/MGET previously hit missing-method TypeErrors
  // that were swallowed by catch fallbacks, so tests silently exercised only
  // the in-memory path.
  hgetall: vi.fn().mockResolvedValue({}),
  hset: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  scan: vi.fn().mockResolvedValue(['0', []]),
  mget: vi.fn().mockResolvedValue([]),
  multi: vi.fn().mockReturnValue({
    exec: vi.fn().mockResolvedValue([]),
  }),
  duplicate: vi.fn().mockReturnThis(),
  status: 'ready',
};

vi.mock('ioredis', () => ({
  // M36: provide a default export too — any default import would break.
  default: vi.fn().mockImplementation(function RedisConstructor() {
    return mockRedisClient;
  }),
  Redis: vi.fn().mockImplementation(function RedisConstructor() {
    return mockRedisClient;
  }),
}));

const mockQueue = {
  add: vi.fn().mockResolvedValue({ id: 'mock-job' }),
  getJob: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getWaitingCount: vi.fn().mockResolvedValue(0),
  getActiveCount: vi.fn().mockResolvedValue(0),
  getCompletedCount: vi.fn().mockResolvedValue(0),
  getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 }),
  getJobs: vi.fn().mockResolvedValue([]),
  // M36: BullMQ methods used by production code that previously errored
  // when a test imported a module touching them.
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  obliterate: vi.fn().mockResolvedValue(undefined),
  clean: vi.fn().mockResolvedValue([]),
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
};

const mockWorker = {
  on: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
};

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function QueueConstructor() {
    return mockQueue;
  }),
  Worker: vi.fn().mockImplementation(function WorkerConstructor() {
    return mockWorker;
  }),
  Job: class Job {},
}));
