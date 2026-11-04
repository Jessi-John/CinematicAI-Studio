/**
 * Regression tests for single-user / invite-only registration mode.
 */

import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';
import { prisma } from '../database/prisma.js';

vi.mock('../database/prisma.js', () => ({
  prisma: vi.fn(),
}));

const registeredUsers = new Map<string, { id: string; username: string; role: string; passwordHash: string }>();

vi.mocked(prisma).mockReturnValue({
  $queryRaw: vi.fn().mockResolvedValue([]),
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(vi.mocked(prisma)())),
  user: {
    findFirst: vi.fn().mockImplementation(async () => registeredUsers.values().next().value ?? null),
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { username?: string } }) => {
      if (where.username) return registeredUsers.get(where.username) ?? null;
      return null;
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: { username: string; passwordHash: string; role: string } }) => {
      const user = { id: `user-${data.username}`, ...data };
      registeredUsers.set(data.username, user);
      return user;
    }),
  },
} as never);

describe('single-user registration mode', () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    process.env.DISABLE_REGISTRATION = 'true';
    process.env.INVITE_CODE = 'super-secret-invite-code';

    const { authRouter } = await import('./auth.js');
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);

    server = app.listen(0);
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    delete process.env.DISABLE_REGISTRATION;
    delete process.env.INVITE_CODE;
    registeredUsers.clear();
  });

  beforeEach(() => {
    registeredUsers.clear();
  });

  async function register(body: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('blocks registration without invite code when DISABLE_REGISTRATION=true', async () => {
    const res = await register({ username: 'newuser', password: 'ValidPass123!' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Registration is disabled');
  });

  it('blocks registration with wrong invite code', async () => {
    const res = await register({ username: 'newuser', password: 'ValidPass123!', inviteCode: 'wrong' });
    expect(res.status).toBe(403);
  });

  it('allows registration with correct invite code', async () => {
    const res = await register({ username: 'newuser', password: 'ValidPass123!', inviteCode: 'super-secret-invite-code' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { user: { username: string } } };
    expect(body.success).toBe(true);
    expect(body.data.user.username).toBe('newuser');
  });
});
