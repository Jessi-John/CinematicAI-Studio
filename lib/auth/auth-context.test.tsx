import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';

const mockApiFetch = vi.fn();
const mockApiRawFetch = vi.fn();

vi.mock('@/lib/utils/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiRawFetch: (...args: unknown[]) => mockApiRawFetch(...args),
}));

vi.mock('@/lib/config', () => ({ API_BASE: 'http://api.test' }));

import { AuthProvider, useAuth } from '@/lib/auth/auth-context';

interface FakeUser {
  id: string;
  username: string;
  role: string;
}

const ALICE: FakeUser = { id: 'u1', username: 'alice', role: 'user' };

/** Minimal Response stand-in: the code under test only reads ok/status/json(). */
function makeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function meSuccess(user: FakeUser = ALICE): Response {
  return makeResponse(200, { success: true, data: { user } });
}

function Consumer() {
  const { user, isAuthenticated, isLoading } = useAuth();
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="auth">{String(isAuthenticated)}</div>
      <div data-testid="user">{user ? user.username : 'none'}</div>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: any un-stubbed raw fetch resolves to a transient 500 so an
    // unexpected call never crashes the test with an undefined return.
    mockApiRawFetch.mockResolvedValue(makeResponse(500));
    mockApiFetch.mockResolvedValue({ success: false, error: 'unstubbed' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates when /api/auth/me returns a user on bootstrap', async () => {
    mockApiRawFetch.mockResolvedValueOnce(meSuccess());
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('alice');
  });

  it('stays logged in across a tab reopen: /me 401 -> /refresh ok -> /me user', async () => {
    mockApiRawFetch
      .mockResolvedValueOnce(makeResponse(401)) // /me: access token expired
      .mockResolvedValueOnce(makeResponse(200, {})) // /refresh: refresh token still valid
      .mockResolvedValueOnce(meSuccess()); // /me retry: now authenticated
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('alice');
    // /me, /refresh, /me — exactly three calls, in order.
    expect(mockApiRawFetch).toHaveBeenCalledTimes(3);
  });

  it('logs out when both /me and /refresh return 401 on bootstrap', async () => {
    mockApiRawFetch
      .mockResolvedValueOnce(makeResponse(401)) // /me
      .mockResolvedValueOnce(makeResponse(401)); // /refresh: refresh token expired too
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('auth').textContent).toBe('false');
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('retries /me once after a transient network error on bootstrap', async () => {
    vi.useFakeTimers();
    mockApiRawFetch
      .mockRejectedValueOnce(new Error('network down')) // first /me throws
      .mockResolvedValueOnce(meSuccess()); // retry succeeds
    renderProvider();
    // Flush the rejected first fetchMe.
    await act(async () => {
      await Promise.resolve();
    });
    // Advance past the 500ms retry delay and flush the second fetchMe.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('alice');
  });

  it('H7: a transient 5xx during the refresh loop does NOT log the user out', async () => {
    vi.useFakeTimers();
    mockApiRawFetch.mockResolvedValueOnce(meSuccess()); // bootstrap /me
    mockApiRawFetch.mockResolvedValue(makeResponse(500)); // every refresh: backend restarting
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('auth').textContent).toBe('true');
    // Fire the refresh timer (~14 min out) and let the backoff cascade settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    });
    // The user must remain authenticated — a transient 5xx is not an auth failure.
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('alice');
    // The refresh endpoint was actually hit (proving the loop ran and was kept alive).
    expect(mockApiRawFetch.mock.calls.some((c) => String(c[0]).includes('/api/auth/refresh'))).toBe(true);
  });

  it('H7: a genuine 401 during the refresh loop DOES log the user out', async () => {
    vi.useFakeTimers();
    mockApiRawFetch.mockResolvedValueOnce(meSuccess()); // bootstrap /me
    mockApiRawFetch.mockResolvedValue(makeResponse(401)); // every refresh: token expired
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('auth').textContent).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    });
    // A 401 means the refresh token is gone — the user must be logged out so
    // RequireAuth can redirect to /login.
    expect(screen.getByTestId('auth').textContent).toBe('false');
    expect(screen.getByTestId('user').textContent).toBe('none');
  });
});
