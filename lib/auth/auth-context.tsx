'use client';

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { apiFetch, apiRawFetch } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';

interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const REFRESH_EARLY_AFTER_MS = 13 * 60 * 1000;
const REFRESH_INTERVAL_MS = 14 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Refresh every 14 minutes, plus immediately on page load if the token
  // was issued more than 13 minutes ago. This ensures the session survives
  // tab closes: on reopen, /refresh is called before /me so the user stays
  // logged in even if the token expired while the tab was closed.
  const loginTimeRef = useRef<number | null>(null);

  const setUser = useCallback((nextUser: User | null) => {
    loginTimeRef.current = nextUser ? Date.now() : null;
    setUserState(nextUser);
  }, []);

  const refreshSession = useCallback(async () => {
    // H7: Use apiRawFetch so we can inspect the HTTP status. apiFetch collapses
    // 401 and 5xx into the same { success:false } shape (the backend returns a
    // JSON error body for both — see lib/utils/api.ts), which made the previous
    // code call setUser(null) on ANY non-2xx — including a transient 5xx from a
    // restarting backend. Only a genuine auth failure (401/403) should clear the
    // session; transient errors must keep the user so the backoff loop recovers.
    let response: Response;
    try {
      response = await apiRawFetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', timeout: 10_000 });
    } catch (err) {
      // Network error / timeout / abort — transient. Keep the user; the
      // refresh loop's backoff will retry. Re-throw so scheduleNext backs off.
      throw err instanceof Error ? err : new Error('Session refresh network error');
    }
    if (response.ok) {
      loginTimeRef.current = Date.now();
      return;
    }
    if (response.status === 401 || response.status === 403) {
      // Genuine auth failure — the refresh token is expired/invalid. Log out so
      // RequireAuth redirects to /login instead of leaving the user in a limbo
      // where they appear logged in but every protected call 401s.
      setUser(null);
      throw new Error('Session expired');
    }
    // Transient server error (5xx) — keep the user; the backoff loop will retry.
    throw new Error(`Session refresh failed with status ${response.status}`);
  }, [setUser]);

  // HIGH-18: Ref guard to prevent concurrent bootstrap calls when React StrictMode
  // double-invokes the effect. Trade-off: HMR re-mounts are NOT re-bootstrapped
  // (the ref persists across mounts), so stale state after a hot reload won't be
  // refreshed. If HMR causes issues, this should be replaced with `useSyncExternalStore`.
  const bootstrappedRef = useRef(false);

  // Bootstrap: call /api/auth/me, refreshing once on a 401 before giving up.
  // If it succeeds, the user is authenticated. A genuine 401 on both /me and
  // /refresh, or a persistent network failure, means unauthenticated.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    // Returns the parsed user on success, or an HTTP status describing the
    // failure (0 = network error / timeout / abort).
    async function fetchMe(): Promise<{ user?: User; status: number }> {
      try {
        const res = await apiRawFetch(`${API_BASE}/api/auth/me`, { timeout: 10_000 });
        if (res.ok) {
          const json = (await res.json().catch(() => null)) as
            | { success?: boolean; data?: { user?: User } }
            | null;
          if (json?.success && json.data?.user) {
            return { user: json.data.user, status: res.status };
          }
        }
        return { status: res.status };
      } catch {
        return { status: 0 };
      }
    }

    async function bootstrap() {
      let me = await fetchMe();
      if (me.user) {
        setUser(me.user);
        return;
      }

      // H7: If /me returned 401, the access token may simply be expired while
      // the refresh-token cookie is still valid (e.g. a tab reopened after the
      // 15-minute access-token TTL). Try one refresh, then re-check /me before
      // giving up — this keeps the user logged in across tab reopens, matching
      // the documented intent above.
      if (me.status === 401) {
        try {
          await refreshSession();
        } catch {
          // Refresh failed: a genuine 401 already cleared the user inside
          // refreshSession; a transient failure means we cannot confirm the
          // session during bootstrap, so treat as unauthenticated.
          setUser(null);
          return;
        }
        me = await fetchMe();
        if (me.user) {
          setUser(me.user);
          return;
        }
        setUser(null);
        return;
      }

      // Network/timeout (status 0): retry once after 500ms for transient blips.
      if (me.status === 0) {
        await new Promise<void>((r) => setTimeout(r, 500));
        me = await fetchMe();
        if (me.user) {
          setUser(me.user);
          return;
        }
      }

      setUser(null);
    }
    bootstrap().finally(() => setIsLoading(false));
  }, [setUser, refreshSession]);

  // Start a self-rescheduling refresh loop whenever the user is set.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // H10: Track retry count for exponential backoff. When refreshSession
    // throws (backend unreachable / 502), the previous code re-scheduled
    // with delay=0 (because elapsed > REFRESH_EARLY_AFTER_MS), creating a
    // tight self-DoS loop hammering /api/auth/refresh as fast as the event
    // loop allows. Now we back off exponentially: 1s, 2s, 4s, 8s, ... max 60s.
    let retryCount = 0;
    const MAX_BACKOFF_MS = 60_000;

    const scheduleNext = () => {
      const elapsed = loginTimeRef.current ? Date.now() - loginTimeRef.current : Infinity;
      const baseDelay = elapsed < REFRESH_EARLY_AFTER_MS ? REFRESH_INTERVAL_MS - elapsed : 0;
      // Apply exponential backoff when retrying after failures
      const backoffDelay = retryCount > 0
        ? Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, retryCount - 1))
        : 0;
      const delay = Math.max(Math.max(baseDelay, 0), backoffDelay);
      timer = setTimeout(async () => {
        try {
          await refreshSession();
          retryCount = 0; // Reset backoff on success
        } catch {
          retryCount++; // Increase backoff on failure
          // refreshSession already clears the user on a genuine 401/403 (which
          // unmounts this loop via the user dep). Here we only handle the
          // transient case: keep the user and back off, so the session recovers
          // automatically when the backend comes back without a forced re-login.
        } finally {
          if (!cancelled) scheduleNext();
        }
      }, delay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user, refreshSession]);

  const login = useCallback(async (username: string, password: string) => {
    const json = await apiFetch<{ user: User }>(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      timeout: 15_000,
      body: JSON.stringify({ username, password }),
    });
    if (!json.success) throw new Error(json.error ?? 'Login failed');
    setUser(json.data.user);
  }, [setUser]);

  const logout = useCallback(async () => {
    try {
      await apiFetch(`${API_BASE}/api/auth/logout`, { method: 'DELETE', timeout: 10_000 });
    } finally {
      setUser(null);
    }
  }, [setUser]);

  const value = useMemo(
    () => ({ user, isAuthenticated: !!user, isLoading, login, logout, setUser }),
    [user, isLoading, login, logout, setUser]
  );
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}