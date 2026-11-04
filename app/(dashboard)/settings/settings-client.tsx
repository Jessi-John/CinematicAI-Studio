'use client';

import { useState, useCallback, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { Database, RefreshCw, Loader2, Server, Key, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/stores/app-store';
import { apiFetch } from '@/lib/utils/api';
import { GENRES, type Genre } from '@/lib/constants/genres';
import { API_BASE } from '@/lib/config';

const useClientApiBase = (): string | null => {
  return useSyncExternalStore(
    () => () => {},
    () => API_BASE,
    () => null
  );
};

const VALID_GENRES: readonly Genre[] = GENRES.map((g) => g.value);

export interface HealthStatus {
  status: string;
  services?: { database: string; redis: string };
  version?: string;
  uptime?: number;
}

export interface UserSetting {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'json';
}

interface SettingsClientProps {
  initialHealth: HealthStatus | null;
  initialStoriesCount: number;
  initialUserSettings: UserSetting[];
}

export default function SettingsClient({
  initialHealth,
  initialStoriesCount,
  initialUserSettings,
}: SettingsClientProps) {
  const clientApiBase = useClientApiBase();
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(initialHealth);
  const [storiesCount, setStoriesCount] = useState<number>(initialStoriesCount);
  // M43: track initial load vs manual refresh — previously every Refresh
  // click unmounted the entire settings UI into a full-page spinner.
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoadedOnce] = useState(true); // SSR provides initial data
  const [isClearing, setIsClearing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const addToast = useAppStore((state) => state.addToast);

  const [preferredGenre, setPreferredGenre] = useState<string>(() => {
    const setting = initialUserSettings.find((s) => s.key === 'preferred_genre');
    return setting?.value ?? '';
  });
  const [autoSaveGenerations, setAutoSaveGenerations] = useState<boolean>(() => {
    const setting = initialUserSettings.find((s) => s.key === 'auto_save_generations');
    return setting?.value === 'true';
  });
  const [isSavingPreference, setIsSavingPreference] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        apiFetch<HealthStatus>(`${API_BASE}/api/health`).catch(() => null),
        apiFetch<{ total: number }>(`${API_BASE}/api/stories?limit=1`).catch(() => null),
      ]);
      if (hRes?.success && 'data' in hRes) setHealthStatus(hRes.data);
      if (sRes?.success && 'data' in sRes) setStoriesCount(sRes.data.total);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const savePreference = useCallback(
    async (key: string, value: string, type: string) => {
      setIsSavingPreference(true);
      try {
        const res = await apiFetch(`${API_BASE}/api/user-settings/${key}`, {
          method: 'PUT',
          isMutation: true,
          body: JSON.stringify({ value, type }),
        });
        if (!res.success) throw new Error(`Failed to save ${key}`);
        addToast('success', 'Preference saved');
      } catch (err) {
        addToast('error', err instanceof Error ? err.message : 'Failed to save preference');
        throw err;
      } finally {
        setIsSavingPreference(false);
      }
    },
    [addToast]
  );

  const handleGenreChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      const previous = preferredGenre;
      setPreferredGenre(value);
      try {
        await savePreference('preferred_genre', value, 'string');
      } catch {
        setPreferredGenre(previous);
      }
    },
    [savePreference, preferredGenre]
  );

  const handleAutoSaveToggle = useCallback(async () => {
    const newValue = !autoSaveGenerations;
    const previous = autoSaveGenerations;
    setAutoSaveGenerations(newValue);
    try {
      await savePreference('auto_save_generations', String(newValue), 'boolean');
    } catch {
      setAutoSaveGenerations(previous);
    }
  }, [autoSaveGenerations, savePreference]);

  const handleClearCache = useCallback((): void => {
    setIsClearing(true);
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('cinematica-') || key?.startsWith('story-')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      sessionStorage.clear();
      addToast('success', `Cleared ${keysToRemove.length} client-side cache entries`);
    } catch {
      addToast('error', 'Failed to clear cache');
    } finally {
      setIsClearing(false);
    }
  }, [addToast]);

  const handleExportBackup = useCallback(async (): Promise<void> => {
    setIsExporting(true);
    try {
      const r = await apiFetch(`${API_BASE}/api/stories/export`);
      if (!r.success) throw new Error('Export failed');
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cinematicai-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast('success', 'Backup exported successfully');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }, [addToast]);

  if (isLoading && !hasLoadedOnce) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 md:pb-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex items-center justify-between"
        >
          <div>
            <h1 className="text-3xl font-bold mb-2">Settings</h1>
            <p className="text-[var(--text-secondary)]">
              System status, server connection, and local cache.
            </p>
          </div>
          <Button onClick={() => void refresh()} variant="secondary" disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </motion.div>

        <div className="space-y-6">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <Settings className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h3 className="font-semibold">User Preferences</h3>
                <p className="text-sm text-[var(--text-tertiary)]">
                  Stored server-side, applies to all sessions
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label htmlFor="preferred-genre" className="text-sm font-medium">
                  Default genre
                </label>
                <select
                  id="preferred-genre"
                  value={preferredGenre}
                  onChange={handleGenreChange}
                  disabled={isSavingPreference}
                  className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm min-w-[160px]"
                >
                  <option value="">— none —</option>
                  {VALID_GENRES.map((g) => (
                    <option key={g} value={g}>
                      {g.charAt(0).toUpperCase() + g.slice(1).replace(/-/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="auto-save" className="text-sm font-medium">
                    Auto-save generations
                  </label>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    Automatically save story after generation completes
                  </p>
                </div>
                <button
                  id="auto-save"
                  role="switch"
                  aria-checked={autoSaveGenerations}
                  onClick={() => void handleAutoSaveToggle()}
                  disabled={isSavingPreference}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    autoSaveGenerations ? 'bg-purple-500' : 'bg-[var(--bg-tertiary)]'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoSaveGenerations ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                <Server className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h3 className="font-semibold">System Status</h3>
                <p className="text-sm text-[var(--text-tertiary)]">
                  Live health of backend services
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-[var(--text-tertiary)]">Backend</dt>
                <dd className="font-mono">
                  {healthStatus?.status === 'healthy' ? (
                    <span className="text-emerald-400">healthy</span>
                  ) : (
                    <span className="text-red-400">{healthStatus?.status ?? 'offline'}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-tertiary)]">Version</dt>
                <dd className="font-mono">{healthStatus?.version ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-tertiary)]">Database</dt>
                <dd className="font-mono">
                  {healthStatus?.services?.database === 'connected' ? (
                    <span className="text-emerald-400">connected</span>
                  ) : (
                    <span className="text-red-400">disconnected</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-tertiary)]">Redis</dt>
                <dd className="font-mono">
                  {healthStatus?.services?.redis === 'connected' ? (
                    <span className="text-emerald-400">connected</span>
                  ) : (
                    <span className="text-red-400">disconnected</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-tertiary)]">Uptime</dt>
                <dd className="font-mono">
                  {healthStatus?.uptime !== undefined
                    ? `${Math.round(healthStatus.uptime / 60)}m`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-tertiary)]">Stories stored</dt>
                <dd className="font-mono">{storiesCount}</dd>
              </div>
            </dl>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <Key className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h3 className="font-semibold">API Configuration</h3>
                <p className="text-sm text-[var(--text-tertiary)]">
                  Configured via API_BASE_URL at container start time
                </p>
              </div>
            </div>
            <div className="text-sm">
              <span className="text-[var(--text-tertiary)]">Endpoint: </span>
              <code className="font-mono bg-[var(--bg-tertiary)] px-2 py-1 rounded text-xs">
                {clientApiBase ?? '…'}
              </code>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <Database className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-semibold">Local Cache</h3>
                <p className="text-sm text-[var(--text-tertiary)]">
                  Browser-side cache only. Server data is unaffected.
                </p>
              </div>
            </div>
            <div className="flex gap-3 flex-wrap">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClearCache}
                disabled={isClearing}
              >
                {isClearing ? 'Clearing...' : 'Clear local cache'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleExportBackup()}
                disabled={isExporting}
              >
                {isExporting ? 'Exporting...' : 'Export all stories'}
              </Button>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-6"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold mb-1">About CinematicAI Studio</h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  Built for YouTube Shorts creators.
                </p>
              </div>
              <div className="text-right text-sm text-[var(--text-tertiary)]">
                <p>{new Date().getFullYear()} CinematicAI</p>
              </div>
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
