/**
 * JWT Concurrency Tests
 *
 * Verifies that two concurrent requests with different JWTs don't
 * cross-contaminate user identity. The jwtMiddleware uses a per-request
 * verifyToken call to set req.user; this test ensures that one request's
 * user doesn't leak into another.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { errorHandler } from './error.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

// The jwtMiddleware uses getJwtSecret() which reads JWT_SECRET from env.
// Set the env var BEFORE importing the middleware so the secret matches
// the one we sign with below.
process.env.JWT_SECRET = 'test-secret-for-concurrency';
process.env.NODE_ENV = 'test';
process.env.API_SECRET = 'test-api-secret-for-concurrency';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.REDIS_PASSWORD = 'test-redis-password';

const SECRET = process.env.JWT_SECRET!;

function makeToken(payload: { sub: string; username: string; role: string }): string {
  // verifyToken() requires jti — tokens signed without it return null.
  const jti = 'test-jti-' + payload.sub + '-' + Date.now();
  return jwt.sign({ ...payload, jti }, SECRET, { expiresIn: '1h' });
}

let server: Server;
let port: number;

beforeAll(async () => {
  const { jwtMiddleware } = await import('./jwt.js');
  const app = express();
  app.use(cookieParser());
  app.use(jwtMiddleware);
  app.get('/api/me', (req, res) => {
    const user = (req as unknown as { user?: { sub: string; username: string; role: string } }).user;
    res.json({ user });
  });
  // Add a small delay to make race conditions more likely to surface
  app.get('/api/slow', (req, res) => {
    const user = (req as unknown as { user?: { sub: string } }).user;
    setTimeout(() => res.json({ sub: user?.sub }), 50);
  });
  // Register error handler last so 5xx returns JSON, not HTML
  app.use(errorHandler);

  server = app.listen(0);
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('JWT — concurrent requests maintain identity', () => {
  it('Two concurrent requests with different JWTs return their own user', async () => {
    const userAToken = makeToken({ sub: 'user-a-id', username: 'alice', role: 'user' });
    const userBToken = makeToken({ sub: 'user-b-id', username: 'bob', role: 'admin' });

    const [resA, resB] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: `Bearer ${userAToken}` },
      }),
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: `Bearer ${userBToken}` },
      }),
    ]);

    const bodyA = await resA.json() as { user: { sub: string; username: string } };
    const bodyB = await resB.json() as { user: { sub: string; username: string } };

    expect(bodyA.user.username).toBe('alice');
    expect(bodyA.user.sub).toBe('user-a-id');
    expect(bodyB.user.username).toBe('bob');
    expect(bodyB.user.sub).toBe('user-b-id');
  });

  it('100 concurrent requests with same JWT all return same identity', async () => {
    const token = makeToken({ sub: 'shared-user', username: 'shared', role: 'user' });

    const requests = Array.from({ length: 100 }, () =>
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    // All should be the same user
    for (const body of bodies) {
      const b = body as { user: { sub: string } };
      expect(b.user.sub).toBe('shared-user');
    }
  });

  it('100 concurrent requests with mixed JWTs return correct identity each', async () => {
    const users = ['alice', 'bob', 'charlie', 'diana'];
    const tokens = users.map((u) =>
      makeToken({ sub: `${u}-id`, username: u, role: 'user' })
    );

    // Interleave requests — 100 total, cycling through users
    const requests = Array.from({ length: 100 }, (_, i) => {
      const token = tokens[i % tokens.length]!;
      return fetch(`http://127.0.0.1:${port}/api/slow`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    for (let i = 0; i < 100; i++) {
      const expected = users[i % users.length];
      const b = bodies[i] as { sub: string };
      expect(b.sub).toBe(`${expected}-id`);
    }
  });

  it('Invalid JWT in one request does not affect other concurrent valid requests', async () => {
    const validToken = makeToken({ sub: 'valid-user', username: 'valid', role: 'user' });

    const requests = [
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: 'Bearer not-a-valid-jwt' },
      }),
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: `Bearer ${validToken}` },
      }),
      fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.garbage.signature' },
      }),
    ];
    const responses = await Promise.all(requests);
    const [r1, r2, r3] = responses;

    // Invalid tokens → 401
    expect(r1?.status).toBe(401);
    expect(r3?.status).toBe(401);

    // Valid token → 200 with correct user
    expect(r2?.status).toBe(200);
    const body2 = await r2!.json() as { user: { sub: string } };
    expect(body2.user.sub).toBe('valid-user');
  });
});
