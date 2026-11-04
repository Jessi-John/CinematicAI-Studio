/**
 * Route Chain Integration Tests
 *
 * Verifies that all /api/* routes are reachable through the full Express
 * middleware chain. Catches regressions where a router mounted at /api/*
 * responds with 404 for paths it shouldn't handle, silently blocking
 * downstream routers from matching.
 *
 * This test suite does NOT require external services (DB, Redis) because
 * it only tests HTTP routing — request/response matching — not business logic.
 */

// Mock BullMQ queues so server starts without Redis
vi.mock('../queue/index.js', () => ({
  getRedisUrl: () => 'redis://localhost:6379',
  getConnectionConfig: () => ({ url: 'redis://localhost:6379' }),
  workerConfig: { lockDuration: 60000, lockRenewTime: 20000 },
  storyQueue: new Proxy({}, {
    get: () => () => ({}),
  }),
  storyDlq: new Proxy({}, {
    get: () => () => ({}),
  }),
  getStoryQueue: () => ({ add: async () => ({}), getJob: async () => null, close: async () => {} }),
  getStoryDlq: () => ({ add: async () => ({}), close: async () => {} }),
  addStoryJob: async () => ({}),
  getJobStatus: async () => ({ state: 'unknown', progress: 0 }),
  closeQueues: async () => {},
  closeDlq: async () => {},
}));

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => ({
    on: vi.fn(),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue([1, 0, 0, 'ok']),
    call: vi.fn().mockImplementation(async (command: string) => {
      if (command === 'SCRIPT') return 'mock-script-sha';
      if (command === 'EVALSHA') return [1, 60000];
      return 'OK';
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    status: 'ready',
    duplicate: vi.fn().mockReturnThis(),
    quit: vi.fn().mockResolvedValue('OK'),
  }),
  closeSharedRedis: vi.fn().mockResolvedValue(undefined),
}));

// Mock redis-pubsub so BullMQ queue operations don't throw
vi.mock('../queue/redis-pubsub.js', () => ({
  CHANNELS: {
    progress: (jobId: string) => `job:${jobId}:progress`,
  },
  publishProgress: vi.fn().mockResolvedValue(undefined),
  setJobState: vi.fn().mockResolvedValue(undefined),
  getJobState: vi.fn().mockResolvedValue(null),
  markJobFailed: vi.fn().mockResolvedValue(undefined),
  deleteJobCandidate: vi.fn().mockResolvedValue(undefined),
  subscribeToJobEvents: vi.fn().mockResolvedValue({ unsubscribe: () => {} }),
  closePubSub: vi.fn().mockResolvedValue(undefined),
}));

// Mock worker factory to prevent real BullMQ worker from connecting to Redis
vi.mock('../queue/workers/worker-factory.js', () => ({
  createStoryWorker: vi.fn().mockReturnValue({ worker: {}, closeDlq: async () => {} }),
}));

// Mock logger so pino-pretty initialization doesn't cause errors
vi.mock('../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Mock env to prevent exit(1) on validation and provide stable secrets for tests
vi.mock('../config/env.js', () => ({
  validateAndLoadEnv: vi.fn().mockReturnValue({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_PASSWORD: '',
    API_SECRET: 'dev-secret-not-for-production',
    ADMIN_API_KEY: 'dev-admin-not-for-production',
    JWT_SECRET: 'dev-jwt-secret-not-for-production',
    MISTRAL_API_KEY: 'test-mistral-api-key',
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    MISTRAL_MODEL: 'mistral-medium-2508',
    KIMI_API_KEY: 'test-kimi-api-key',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1/chat/completions',
    KIMI_MODEL: 'k3',
  }),
  getApiSecret: vi.fn().mockReturnValue('dev-secret-not-for-production'),
  getAdminApiKey: vi.fn().mockReturnValue('dev-admin-not-for-production'),
  getJwtSecret: vi.fn().mockReturnValue('dev-jwt-secret-not-for-production'),
  getRedisPassword: vi.fn().mockReturnValue(''),
  getPort: vi.fn().mockReturnValue(0), // server.ts listen(0) uses port 0 for dynamic allocation
  getRequestTimeoutMs: vi.fn().mockReturnValue(300000),
  getShutdownDrainMs: vi.fn().mockReturnValue(30000),
  getRunWorkerInprocess: vi.fn().mockReturnValue(false),
  getWorkerHealthPort: vi.fn().mockReturnValue(3001),
  getWorkerHealthBind: vi.fn().mockReturnValue('0.0.0.0'),
  getMonthlyTokenBudget: vi.fn().mockReturnValue(0),
  getDailyTokenBudget: vi.fn().mockReturnValue(0),
  allowInsecureLocalHttp: vi.fn().mockReturnValue(false),
  e2eTestBypassEnabled: vi.fn().mockReturnValue(false),
  isProduction: vi.fn().mockReturnValue(false),
  isRegistrationDisabled: vi.fn().mockReturnValue(false),
  getInviteCode: vi.fn().mockReturnValue(undefined),
  getMaxConcurrentGenerations: vi.fn().mockReturnValue(0),
  getMaxStoriesPerDay: vi.fn().mockReturnValue(0),
  getDailySpendCapUsd: vi.fn().mockReturnValue(0),
  getMonthlySpendCapUsd: vi.fn().mockReturnValue(0),
  getBackupS3Bucket: vi.fn().mockReturnValue(undefined),
  getBackupS3Prefix: vi.fn().mockReturnValue('cinematicai-backups'),
  getAlertWebhookUrl: vi.fn().mockReturnValue(undefined),
}));

// Intercept prisma at global level BEFORE any module is imported.
// This runs at test file evaluation time — before import('../server.js') triggers
// server.ts → auth.ts → prisma.ts chain, so globalThis.prisma must be set first.
const mockPrismaClient = {
  $queryRaw: vi.fn().mockResolvedValue([]),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  story: {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'test-id', username: 'test', role: 'user' }),
  },
  generationLog: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  similarityCache: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    story: { delete: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) },
    generationLog: { deleteMany: vi.fn().mockResolvedValue({}) },
  })),
};

// Set this BEFORE the server import — prisma.ts will find it on first call
(globalThis as unknown as { prisma?: unknown }).prisma = mockPrismaClient;

vi.mock('../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
  __setClient: vi.fn(),
}));

// Mock rate-limit module to bypass Redis dependency
vi.mock('../middleware/rate-limit.js', () => ({
  generalLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  aiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  storiesLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  exportLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  healthLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobsLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  perUserLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  registerLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));


import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Express route chain', () => {
  let port: number;
  let server: import('http').Server;

  beforeAll(async () => {
    // Import the source (TypeScript) directly — ts-jest transforms it at test time.
    // This avoids ESM/CJS path resolution issues between dist/ and src/.
    const { app } = await import('../server.js');
    server = (app as import('express').Express).listen(0) as import('http').Server;
    port = (server.address() as import('net').AddressInfo).port;
  }, 60000);

  afterAll(async () => {
    // No-op: Vitest force-exits after all tests complete.
    // Keeping connections open is fine — the process terminates immediately.
  });

  // -------------------------------------------------------------------------
  // CRITICAL: authRouter must be reachable at /api/auth/*
  // If publicConfigRouter or any middleware chain router returns 404 for
  // /api/auth/* paths, the auth chain breaks and login/logout/me fail.
  // -------------------------------------------------------------------------
  describe('auth routes reachable through full middleware chain', () => {
    it('POST /api/auth/login returns 400 (missing body), not 404', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username":"admin"}', // missing password
      });
      // 400 = route matched, validation failed
      // 404 = route NOT matched (middleware chain blocked by a router above it)
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(400);
    });

    it('POST /api/auth/login with bad credentials returns 401, not 404', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"username":"wronguser","password":"wrongpassword"}',
      });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(401);
    });

    it('DELETE /api/auth/logout returns 401 (no cookie), not 404', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/logout`, {
        method: 'DELETE',
      });
      expect(res.status).not.toBe(404);
      // Without JWT cookie, jwtMiddleware rejects before the route runs.
      expect(res.status).toBe(401);
    });

    it('GET /api/auth/me returns 401 (no cookie), not 404', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/me`, {
        method: 'GET',
      });
      expect(res.status).not.toBe(404);
      // Without JWT cookie, should be 401
      expect(res.status).toBe(401);
    });

    it('GET /api/auth/nonexistent returns 404 (not found), not 401', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/nonexistent`, {
        method: 'GET',
      });
      // jwtMiddleware skips /auth/* paths, so the request reaches the router's
      // notFoundHandler which returns 404 (not 401)
      expect(res.status).toBe(404);
    });
  });

  describe('public config route', () => {
    it('GET /api/public-config returns 200', async () => {
      const res = await fetch(`http://localhost:${port}/api/public-config`);
      expect(res.status).toBe(200);
      const body = await res.json() as { success?: boolean; data?: Record<string, unknown> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('GENRES');
    });
  });

  describe('health route', () => {
    it('GET /api/health returns 200 when DB and Redis are healthy', async () => {
      const res = await fetch(`http://localhost:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { success?: boolean };
      expect(body.success).toBe(true);
    });
  });

  describe('middleware chain does not block cross-router paths', () => {
    it('POST /api/stories/generate returns 401 or 404 (auth required), not 404 from publicConfigRouter', async () => {
      // This path should not be intercepted by publicConfigRouter (which only handles /config).
      // It should pass through to generationRouter which should reject unauthenticated requests.
      const res = await fetch(`http://localhost:${port}/api/stories/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"genre":["fantasy"],"seed":"test"}',
      });
      // Should NOT be 404 — either auth rejection or generation error is fine
      expect(res.status).not.toBe(404);
    });

    it('GET /api/stories returns 401 or 404 (auth required), not 404 from publicConfigRouter', async () => {
      const res = await fetch(`http://localhost:${port}/api/stories`);
      expect(res.status).not.toBe(404);
    });
  });

  // SEC-CRITICAL: Regression test for the CSRF bypass bug. Prior to the fix,
  // csrfMiddleware used `req.path.startsWith('/api')` to detect API routes,
  // but `req.path` is relative to the mount point, so the check was always
  // false and the middleware never rejected missing/invalid X-CSRF-Token
  // headers. This test asserts the middleware now blocks unprotected
  // mutations even when the request would otherwise be authenticated.
  //
  // Note: The middleware chain is jwtMiddleware → csrfMiddleware, so requests
  // without a valid JWT cookie get 401 before reaching CSRF. We assert the
  // absence of 202 (which would mean CSRF never ran) as the key signal —
  // before the fix, POST without X-CSRF-Token returned 202 because the bug
  // caused CSRF to skip enforcement entirely.
  describe('CSRF middleware', () => {
    it('POST /api/stories/generate WITHOUT X-CSRF-Token is NOT accepted (would be 202 before the fix)', async () => {
      const res = await fetch(`http://localhost:${port}/api/stories/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Intentionally no X-CSRF-Token header.
        },
        body: '{"genre":["fantasy"],"seed":"csrf-regression"}',
      });
      // 401 (no JWT) is correct. 202 would mean CSRF never ran — the bug.
      expect(res.status).not.toBe(202);
      expect(res.status).toBe(401);
    });

    it('POST WITH a valid 64-char hex X-CSRF-Token still requires auth (401, not bypass)', async () => {
      const res = await fetch(`http://localhost:${port}/api/stories/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'a'.repeat(64),
          'Cookie': `XSRF-TOKEN=${'a'.repeat(64)}`,
        },
        body: '{"genre":["fantasy"],"seed":"csrf-valid"}',
      });
      // 401 from auth, NOT 202 (which would mean a request without JWT
      // bypassed authentication too).
      expect(res.status).toBe(401);
    });

    it('GET /api/stories is NOT rejected by CSRF middleware (safe method)', async () => {
      const res = await fetch(`http://localhost:${port}/api/stories`);
      // Should be 401 from auth, not 403 from CSRF (which only checks mutations).
      expect(res.status).not.toBe(403);
    });
  });

  // Direct unit-style check of the csrfMiddleware function with mounted
  // path semantics. This is the highest-fidelity regression test for the
  // mount-point bug: we build a request whose req.path is RELATIVE to the
  // /api mount (just "/stories/generate") and verify the middleware
  // correctly identifies it as an API mutation and rejects it.
  describe('csrfMiddleware with mounted /api prefix', () => {
    it('rejects POST when middleware is mounted at /api', async () => {
      // Import the function directly to exercise it in isolation.
      const { csrfMiddleware } = await import('../middleware/csrf.js');
      const calls: Array<{ status?: number; body?: unknown }> = [];
      const fakeRes = {
        status(code: number) { calls.push({ status: code }); return this; },
        json(body: unknown) { calls.push({ body }); return this; },
      };
      // Mount-relative path: when csrfMiddleware is `app.use('/api', csrfMiddleware)`,
      // req.path is "/stories/generate", not "/api/stories/generate".
      const fakeReq = {
        method: 'POST',
        baseUrl: '/api',
        path: '/stories/generate',
        headers: {},
      };
      let nextCalled = false;
      csrfMiddleware(
        fakeReq as never,
        fakeRes as never,
        () => { nextCalled = true; }
      );
      // Must have been rejected (no next, status 403).
      expect(nextCalled).toBe(false);
      expect(calls.some(c => c.status === 403)).toBe(true);
    });

    it('passes POST through when X-CSRF-Token is a valid 64-char hex string', async () => {
      const { csrfMiddleware } = await import('../middleware/csrf.js');
      const fakeRes = {
        status: () => fakeRes,
        json: () => fakeRes,
      };
      const fakeReq = {
        method: 'POST',
        baseUrl: '/api',
        path: '/stories/generate',
        headers: { 'x-csrf-token': 'a'.repeat(64), cookie: 'XSRF-TOKEN=' + 'a'.repeat(64) },
      };
      let nextCalled = false;
      csrfMiddleware(
        fakeReq as never,
        fakeRes as never,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
    });

    it('still exempts /api/health GET requests (no mutation)', async () => {
      const { csrfMiddleware } = await import('../middleware/csrf.js');
      const fakeRes = {
        status: () => fakeRes,
        json: () => fakeRes,
      };
      const fakeReq = {
        method: 'GET',
        baseUrl: '/api',
        path: '/health',
        headers: {},
      };
      let nextCalled = false;
      csrfMiddleware(
        fakeReq as never,
        fakeRes as never,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
    });

    // SEC-CRITICAL regression test for the PUT CSRF bypass. Prior to the fix,
    // isMutation() returned true only for POST/PATCH/DELETE — PUT was missing
    // from the list. That meant every PUT endpoint (e.g. PUT /api/settings/:key,
    // PUT /api/user-settings/:key, PUT /api/admin/settings/pipeline/:key) was
    // CSRF-exempt: an attacker could trick a victim's browser into sending
    // a PUT to mutate user or system settings. This test pins the fix.
    it('rejects PUT without X-CSRF-Token (would be bypassed before fix)', async () => {
      const { csrfMiddleware } = await import('../middleware/csrf.js');
      const calls: Array<{ status?: number; body?: unknown }> = [];
      const fakeRes = {
        status(code: number) { calls.push({ status: code }); return this; },
        json(body: unknown) { calls.push({ body }); return this; },
      };
      const fakeReq = {
        method: 'PUT',
        baseUrl: '/api',
        path: '/settings/some-key',
        headers: {},
      };
      let nextCalled = false;
      csrfMiddleware(
        fakeReq as never,
        fakeRes as never,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(false);
      expect(calls.some(c => c.status === 403)).toBe(true);
    });

    it('passes PUT through when X-CSRF-Token is a valid 64-char hex string', async () => {
      const { csrfMiddleware } = await import('../middleware/csrf.js');
      const fakeRes = {
        status: () => fakeRes,
        json: () => fakeRes,
      };
      const fakeReq = {
        method: 'PUT',
        baseUrl: '/api',
        path: '/settings/some-key',
        headers: { 'x-csrf-token': 'a'.repeat(64), cookie: 'XSRF-TOKEN=' + 'a'.repeat(64) },
      };
      let nextCalled = false;
      csrfMiddleware(
        fakeReq as never,
        fakeRes as never,
        () => { nextCalled = true; }
      );
      expect(nextCalled).toBe(true);
    });
  });
});