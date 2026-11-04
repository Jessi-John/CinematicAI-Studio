'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { useState, useMemo, useSyncExternalStore } from 'react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

// L4-LOGIN-REDUX: friendly flash message when a user is redirected
// to /login. The proxy sends unauthenticated users to
// /login?from=<original-path>&msg=<reason>. We read both and:
//   - show <msg> as a one-time info banner above the form
//   - redirect to <from> after successful login (defaults to "/")
// The default msg is "Please sign in to continue" when no
// reason is provided, so the page never appears blank to a
// redirected user.
//
// NOTE: We deliberately avoid Next.js's useSearchParams() because it forces a
// CSR bailout — the form content is replaced by a loading skeleton during SSR.
// Instead we read the query string via useSyncExternalStore. React uses the
// server snapshot ('') during SSR AND the hydration render — so the banner is
// absent in both and there is NO hydration mismatch — then swaps to the client
// snapshot afterwards, populating the banner with no extra bailout. The form
// itself never depends on msg/from, so it is never replaced by a skeleton.
function subscribeNoop(): () => void {
  return () => {};
}
function getClientSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}
function getServerSearch(): string {
  return '';
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  // Hydration-safe: '' on the server and during hydration (banner hidden and
  // markup matches), real query string on the client afterwards.
  const search = useSyncExternalStore(subscribeNoop, getClientSearch, getServerSearch);
  const { msg, from } = useMemo(() => {
    const params = new URLSearchParams(search);
    return { msg: params.get('msg'), from: params.get('from') };
  }, [search]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Only show the flash banner when the user was redirected here (msg or from
  // is present). Otherwise the banner is hidden so direct /login navigation
  // does not flash an irrelevant message during SSR/hydration.
  const flashMessage = msg ?? (from ? 'Please sign in to continue' : null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please enter username and password');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await login(username.trim(), password);
      const safeFrom = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';
      router.push(safeFrom);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ErrorBoundary>
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-primary)]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md px-6"
        >
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">🎬</div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              CinematicAI Studio
            </h1>
            <p className="text-[var(--text-secondary)] mt-2">
              Sign in with your credentials
            </p>
          </div>

          {flashMessage && (
            <div
              role="status"
              aria-live="polite"
              className="mb-4 rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-3 text-sm text-purple-200"
            >
              {flashMessage}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-6 space-y-4"
          >
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-[var(--text-secondary)] mb-2"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError('');
                }}
                placeholder="admin"
                aria-invalid={error ? 'true' : 'false'}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
                autoFocus
                autoComplete="username"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[var(--text-secondary)] mb-2"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
                placeholder="Enter your password"
                aria-invalid={error ? 'true' : 'false'}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p id="login-form-error" role="alert" className="text-sm text-red-400">{error}</p>
            )}

            <Button type="submit" isLoading={isLoading} className="w-full">
              Sign In
            </Button>

            <p className="text-center text-sm text-[var(--text-secondary)]">
              No account?{' '}
              <button
                type="button"
                onClick={() => router.push('/register')}
                className="text-purple-400 hover:text-purple-300 font-medium focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded"
              >
                Create one
              </button>
            </p>
          </form>
        </motion.div>
      </div>
    </ErrorBoundary>
  );
}