/**
 * CSRF Matrix Tests
 *
 * Exhaustive CSRF protection matrix.
 * Verifies that the CSRF middleware protects every mutation method on every
 * route that requires it, and that exempt paths (GET, HEAD, OPTIONS, /health,
 * /metrics, SSE) bypass correctly. Any unprotected mutation route is a
 * CSRF vulnerability that would let an attacker mutate state from a victim's
 * browser.
 *
 * The test mounts a minimal Express app with csrfMiddleware + a few stub
 * routes, then issues requests with/without the X-CSRF-Token header and
 * asserts the response.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { csrfMiddleware, CSRF_EXEMPT_PATHS, CSRF_MUTATION_METHODS } from './csrf.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

let server: Server;
let port: number;
const TOKEN = 'a'.repeat(64); // 64-char hex
const TOKEN_BAD = 'not-hex';
const TOKEN_SHORT = 'a'.repeat(63); // 63 chars

/** Build Cookie header for CSRF double-submit pattern tests */
function csrfCookie(token: string = TOKEN): string {
  return `XSRF-TOKEN=${token}`;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', csrfMiddleware);

  // Stub routes covering each method/path combination we want to test
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  app.put('/api/test', (_req, res) => res.json({ ok: true }));
  app.patch('/api/test', (_req, res) => res.json({ ok: true }));
  app.delete('/api/test', (_req, res) => res.json({ ok: true }));
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.head('/api/test', (_req, res) => res.end());
  app.options('/api/test', (_req, res) => res.end());

  // Exempt routes
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/metrics', (_req, res) => res.send('metrics'));

  // SSE exempt
  app.get('/api/stories/generate/job-123/events', (_req, res) => res.json({ ok: true }));

  // Sub-path of exempt
  app.get('/api/health/deep', (_req, res) => res.json({ ok: true }));

  server = app.listen(0);
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, headers: Record<string, string> = {}): Promise<Response> {
  // Include XSRF-TOKEN cookie matching the header for valid double-submit tests
  const csrfToken = headers['X-CSRF-Token'] || TOKEN;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      ...headers,
      Cookie: `XSRF-TOKEN=${csrfToken}`,
    },
  });
}

describe('CSRF — exported constants', () => {
  it('CSRF_EXEMPT_PATHS contains /health and /metrics only', () => {
    expect(CSRF_EXEMPT_PATHS).toContain('/health');
    expect(CSRF_EXEMPT_PATHS).toContain('/metrics');
    expect(CSRF_EXEMPT_PATHS.length).toBe(2);
  });

  it('CSRF_MUTATION_METHODS contains POST, PUT, PATCH, DELETE', () => {
    expect(CSRF_MUTATION_METHODS).toContain('POST');
    expect(CSRF_MUTATION_METHODS).toContain('PUT');
    expect(CSRF_MUTATION_METHODS).toContain('PATCH');
    expect(CSRF_MUTATION_METHODS).toContain('DELETE');
    // MUST NOT include GET/HEAD/OPTIONS — those are safe methods
    expect(CSRF_MUTATION_METHODS).not.toContain('GET');
    expect(CSRF_MUTATION_METHODS).not.toContain('HEAD');
    expect(CSRF_MUTATION_METHODS).not.toContain('OPTIONS');
  });
});

describe('CSRF — every mutation method requires X-CSRF-Token', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`${method} without CSRF header → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method });
      expect(res.status).toBe(403);
    });

    it(`${method} with valid 64-char hex CSRF + matching cookie → 200`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN, Cookie: csrfCookie() },
      });
      expect(res.status).toBe(200);
    });

    it(`${method} with non-hex CSRF → 403 (format check fails before cookie match)`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN_BAD },
      });
      expect(res.status).toBe(403);
    });

    it(`${method} with short CSRF (63 chars) → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN_SHORT },
      });
      expect(res.status).toBe(403);
    });

    it(`${method} with long CSRF (65 chars) → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN + 'a' },
      });
      expect(res.status).toBe(403);
    });

    it(`${method} with empty CSRF → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': '' },
      });
      expect(res.status).toBe(403);
    });

    it(`${method} with valid hex header but missing cookie → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN },
      });
      expect(res.status).toBe(403);
    });

    it(`${method} with header/cookie mismatch → 403`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/test`, {
        method,
        headers: { 'X-CSRF-Token': TOKEN, Cookie: csrfCookie('b'.repeat(64)) },
      });
      expect(res.status).toBe(403);
    });
  }
});

describe('CSRF — safe methods are exempt', () => {
  it('GET without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/test`);
    expect(res.status).toBe(200);
  });

  it('HEAD without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('OPTIONS without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/test`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
  });
});

describe('CSRF — exempt paths bypass', () => {
  it('GET /api/health without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('GET /api/metrics without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    expect(res.status).toBe(200);
  });

  it('GET /api/health/deep (subpath of exempt) without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/deep`);
    expect(res.status).toBe(200);
  });

  it('POST /api/health (exempt path) without CSRF → still goes to handler', async () => {
    // /health is exempt regardless of method — confirm 404 (not mounted for POST)
    // rather than 403 (CSRF rejection)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('CSRF — SSE path is exempt', () => {
  it('GET /api/stories/generate/job-123/events without CSRF → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stories/generate/job-123/events`);
    expect(res.status).toBe(200);
  });
});

describe('CSRF — case sensitivity of token characters', () => {
  it('Uppercase hex chars accepted (64 chars)', async () => {
    const upperToken = 'A'.repeat(32) + 'B'.repeat(32);
    const res = await post('/api/test', { 'X-CSRF-Token': upperToken });
    expect(res.status).toBe(200);
  });

  it('Mixed-case hex chars accepted (64 chars)', async () => {
    const mixedToken = ('aB'.repeat(32));
    const res = await post('/api/test', { 'X-CSRF-Token': mixedToken });
    expect(res.status).toBe(200);
  });

  it('Non-hex char in token → 403', async () => {
    const bad = 'g'.repeat(64); // 'g' is not hex
    const res = await post('/api/test', { 'X-CSRF-Token': bad });
    expect(res.status).toBe(403);
  });
});
