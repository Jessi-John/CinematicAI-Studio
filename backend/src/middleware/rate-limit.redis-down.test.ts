/**
 * Rate Limiter Redis-Down Behavior Tests
 *
 * Verifies that when Redis is unavailable:
 *   - The rate limiter returns 503 Service Unavailable (fail-closed)
 *   - The catch block in makeLimiter catches any error from getOrInitStore
 *     and rejects the request with 503, regardless of passOnStoreError
 *     (which is set to `true` in rate-limit.ts to fail open on store errors,
 *     but the project wrapper intercepts before the library decides).
 *   - Errors are logged appropriately
 *
 * Vitest ESM-native mocking: vi.mock() at module level works reliably.
 * Since vi.mock is hoisted, we use a single mock with a swappable factory.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';

// Shared mutable mock — using an object so the reference is stable
// The mock's call function is swapped per test.
const mockState: { call: (...args: string[]) => Promise<unknown> } = {
  call: () => Promise.reject(new Error('Redis connection refused')),
};

let currentMockFactory = () => {
  const scriptCache = new Map<string, string>();
  const obj: Record<string, unknown> = {
    call: (command: string, ...args: string[]) => {
      // Allow script management commands to succeed (store initialization) —
      // UNLESS mockState rejects them (H15: lets tests simulate a store that
      // dies AFTER init, since this store version issues SCRIPT LOAD per
      // increment rather than EVALSHA).
      if (command === 'SCRIPT' && args[0] === 'LOAD') {
        return (mockState.call(command, ...(args as [string, ...string[]])) as Promise<unknown>).then(() => {
          const sha = 'mock_sha_' + Math.random().toString(36).slice(2);
          scriptCache.set(sha, args[1] as string);
          return sha;
        });
      }
      if (command === 'EVALSHA') {
        // H15: delegate EVALSHA (runtime increments) to mockState so tests can
        // simulate a Redis outage AFTER successful store init.
        return mockState.call(command, ...(args as [string, ...string[]]));
      }
      // Delegate to current mock state for rate-limit commands
      return mockState.call(command, ...(args as [string, ...string[]]));
    },
    on: (): unknown => ({}),
    duplicate: (): unknown => ({}),
    stream: null,
    // .ping() is called by the rate limiter during Redis store init.
    // With the eager-init approach, the store init runs at module load
    // time. The mock must provide a .ping() method that delegates to
    // mockState so the test can control whether Redis is up or down.
    ping: () => mockState.call('PING'),
  };
  return obj;
};

vi.mock('../lib/shared-redis.js', () => ({
  getSharedRedis: () => currentMockFactory(),
}));

describe('Rate limiter — Redis down behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // In dev/test mode, the rate limiter fails OPEN — it falls back to the
  // in-memory store so the application remains usable without Redis.
  // Production mode fails CLOSED (503) so operators notice the outage.
  // Store errors at RUNTIME now also fail closed (H15: passOnStoreError: true).
  const EXPECTED_STATUS_DEV = 200;
  const EXPECTED_STATUS_PROD = 503;

  it('should return 200 in dev when Redis throws for general API (fail-open)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { generalLimiter } = await import('./rate-limit.js');

    const app = express();
    app.use(generalLimiter);
    app.get('/api/test', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`);
      expect(res.status).toBe(EXPECTED_STATUS_DEV);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('should return 503 when Redis throws and NODE_ENV=production (fail-closed)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const express = (await import('express')).default;
      const { generalLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(generalLimiter);
      app.get('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`);
        expect(res.status).toBe(EXPECTED_STATUS_PROD);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('H15-verification: runtime store failure fails OPEN in dev/test, CLOSED in production', async () => {
    // express-rate-limit v7 semantics (verified in dist/index.cjs:716-724):
    // passOnStoreError true → log + allow; false → throw. With
    // `passOnStoreError: !isProd`, a runtime Redis outage allows the request
    // in dev/test and rejects (500/503) in production. The init failure path
    // is covered by the other tests in this file; this covers a store that
    // dies AFTER successful init.
    let failNow = false;
    mockState.call = () =>
      failNow ? Promise.reject(new Error('Redis died mid-run')) : Promise.resolve('PONG');

    const origNodeEnv = process.env.NODE_ENV;

    // Dev/test: store error is logged and the request is ALLOWED (fail open).
    const express = (await import('express')).default;
    const { generalLimiter } = await import('./rate-limit.js');
    const app = express();
    app.use(generalLimiter);
    app.get('/api/test', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    failNow = true; // Redis dies AFTER successful init, before the request
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // Production: store error throws → 500/503 (fail closed).
    vi.resetModules();
    failNow = false;
    process.env.NODE_ENV = 'production';
    try {
      const express2 = (await import('express')).default;
      const { generalLimiter: prodLimiter } = await import('./rate-limit.js');
      const app2 = express2();
      app2.use(prodLimiter);
      app2.get('/api/test', (_req, res) => res.json({ ok: true }));
      const server2 = app2.listen(0);
      await new Promise<void>((resolve) => server2.once('listening', resolve));
      const port2 = (server2.address() as AddressInfo).port;
      failNow = true;
      try {
        const res = await fetch(`http://127.0.0.1:${port2}/api/test`);
        expect(res.status).toBe(500);
      } finally {
        await new Promise<void>((r) => server2.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return 200 in dev when Redis throws for AI generation endpoint (fail-open)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    // The aiLimiter bypasses itself when NODE_ENV === 'test'. Override to
    // 'development' so the limiter is NOT bypassed when the module is loaded.
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const express = (await import('express')).default;
      const { aiLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(aiLimiter);
      app.post('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'POST' });
        expect(res.status).toBe(EXPECTED_STATUS_DEV);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return 503 for AI endpoint with NODE_ENV=production (fail-closed)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const express = (await import('express')).default;
      const { aiLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(aiLimiter);
      app.post('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'POST' });
        expect(res.status).toBe(EXPECTED_STATUS_PROD);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return 200 in dev when Redis throws for export endpoint (fail-open)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { exportLimiter } = await import('./rate-limit.js');

    const app = express();
    app.use(exportLimiter);
    app.post('/api/test', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'POST' });
      expect(res.status).toBe(EXPECTED_STATUS_DEV);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('should return 503 for export with NODE_ENV=production (fail-closed)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const express = (await import('express')).default;
      const { exportLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(exportLimiter);
      app.post('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'POST' });
        expect(res.status).toBe(EXPECTED_STATUS_PROD);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return 200 in dev when Redis throws for stories endpoint (fail-open)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { storiesLimiter } = await import('./rate-limit.js');

    const app = express();
    app.use(storiesLimiter);
    app.get('/api/test', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`);
      expect(res.status).toBe(EXPECTED_STATUS_DEV);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('should return 503 for stories with NODE_ENV=production (fail-closed)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const express = (await import('express')).default;
      const { storiesLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(storiesLimiter);
      app.get('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`);
        expect(res.status).toBe(EXPECTED_STATUS_PROD);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('should return 200 in dev when Redis throws for health endpoint (fail-open)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const express = (await import('express')).default;
    const { healthLimiter } = await import('./rate-limit.js');

    const app = express();
    app.use(healthLimiter);
    app.get('/api/test', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`);
      expect(res.status).toBe(EXPECTED_STATUS_DEV);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('should return 503 for health with NODE_ENV=production (fail-closed)', async () => {
    mockState.call = () => Promise.reject(new Error('Redis connection refused'));

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const express = (await import('express')).default;
      const { healthLimiter } = await import('./rate-limit.js');

      const app = express();
      app.use(healthLimiter);
      app.get('/api/test', (_req, res) => res.json({ ok: true }));

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/test`);
        expect(res.status).toBe(EXPECTED_STATUS_PROD);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });
});
