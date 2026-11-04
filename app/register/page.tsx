'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/error-boundary';
import { API_BASE } from '@/lib/config';
import { apiFetch } from '@/lib/utils/api';
import { useAuth } from '@/lib/auth/auth-context';
import { motion } from 'framer-motion';

function calcStrength(password: string): { label: string; score: number; color: string } {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;
  if (score <= 2) return { label: 'Weak', score: 0, color: 'bg-red-500' };
  if (score <= 4) return { label: 'Fair', score: 1, color: 'bg-yellow-500' };
  if (score <= 5) return { label: 'Good', score: 2, color: 'bg-blue-500' };
  return { label: 'Strong', score: 3, color: 'bg-emerald-500' };
}

function meetsBackendStrength(password: string): boolean {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;
  return score >= 3;
}

function PasswordStrength({ password }: { password: string }) {
  const { label, score, color } = calcStrength(password);
  return (
    <div className="mt-2">
      <div className="flex gap-1 mb-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i <= score ? color : 'bg-[var(--border)]'}`}
          />
        ))}
      </div>
      <p className={`text-xs ${score <= 1 ? 'text-red-400' : score === 2 ? 'text-blue-400' : 'text-emerald-400'}`}>
        {label}
      </p>
    </div>
  );
}

function RegisterForm() {
  const router = useRouter();
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [registrationDisabled, setRegistrationDisabled] = useState(false);

  useEffect(() => {
    apiFetch<{ registrationDisabled?: boolean }>(`${API_BASE}/api/public-config`)
      .then((res) => {
        if (res.success && res.data) {
          setRegistrationDisabled(!!res.data.registrationDisabled);
        }
      })
      .catch(() => {
        // Leave default (enabled) so the form is still usable if config fails.
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }
    if (username.length < 3 || username.length > 30) {
      setError('Username must be 3–30 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setError('Username may only contain letters, numbers, and underscores');
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError('Password must be 8–128 characters');
      return;
    }
    if (!meetsBackendStrength(password)) {
      setError('Password is too weak. Use a mix of uppercase, lowercase, numbers, and special characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (registrationDisabled && !inviteCode.trim()) {
      setError('Invite code is required');
      return;
    }

    setIsLoading(true);
    try {
      const body: Record<string, string> = { username: username.trim(), password };
      if (registrationDisabled) {
        body.inviteCode = inviteCode.trim();
      }
      const res = await apiFetch<{ user: { id: string; username: string; role: string } }>(
        `${API_BASE}/api/auth/register`,
        {
          method: 'POST',
          isMutation: true,
          body: JSON.stringify(body),
        }
      );
      if (res.success && res.data?.user) {
        setUser(res.data.user);
        router.push('/');
      } else if (!res.success) {
        setError(res.error);
      } else {
        setError('Registration failed');
      }
    } catch {
      setError('Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-primary)]">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md px-6"
      >
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🎬</div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Create Account
          </h1>
          <p className="text-[var(--text-secondary)] mt-2">
            Join CinematicAI Studio
          </p>
        </div>

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
              placeholder="my_username"
              aria-invalid={error ? 'true' : 'false'}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
              autoFocus
              autoComplete="username"
              maxLength={30}
            />
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              3–30 characters, letters, numbers, underscores
            </p>
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
              placeholder="Min. 8 characters"
              aria-invalid={error ? 'true' : 'false'}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
              autoComplete="new-password"
              maxLength={128}
            />
            {password.length > 0 && <PasswordStrength password={password} />}
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-sm font-medium text-[var(--text-secondary)] mb-2"
            >
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setError('');
              }}
              placeholder="Repeat password"
              aria-invalid={error ? 'true' : 'false'}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
              autoComplete="new-password"
              maxLength={128}
            />
          </div>

          {registrationDisabled && (
            <div>
              <label
                htmlFor="inviteCode"
                className="block text-sm font-medium text-[var(--text-secondary)] mb-2"
              >
                Invite Code
              </label>
              <input
                id="inviteCode"
                type="text"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value);
                  setError('');
                }}
                placeholder="Required — registration is invite-only"
                aria-invalid={error ? 'true' : 'false'}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
                autoComplete="off"
              />
            </div>
          )}

          {error && (
            <p id="register-form-error" role="alert" className="text-sm text-red-400">{error}</p>
          )}

          <Button type="submit" isLoading={isLoading} className="w-full">
            Create Account
          </Button>

          <p className="text-center text-sm text-[var(--text-secondary)]">
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="text-purple-400 hover:text-purple-300 font-medium focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded"
            >
              Sign in
            </button>
          </p>
        </form>
      </motion.div>
    </div>
  );
}

export default function RegisterPage() {
  return <ErrorBoundary><RegisterForm /></ErrorBoundary>;
}