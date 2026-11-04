'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  RefreshCw,
  Zap,
  Clock,
  Activity,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/stores/app-store';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';

interface HealthApiResponse {
  status: string;
  services?: { database: string; redis: string };
  version?: string;
  uptime?: number;
}

interface QueueStatus {
  queueDepth: number;
  activeJobs: number;
  completedToday: number;
  dlqDepth: number;
  recentFailures: Array<{
    jobId: string;
    genre: string[];
    failedAt: number;
    failedReason: string;
    attemptsMade: number;
  }>;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function ServiceBadge({ label, status }: { label: string; status: 'ok' | 'degraded' | 'error' }) {
  const icon =
    status === 'ok' ? <CheckCircle size={14} className="text-green-400" /> :
    status === 'degraded' ? <AlertTriangle size={14} className="text-yellow-400" /> :
    <XCircle size={14} className="text-red-400" />;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-xs text-[var(--text-secondary)]">
      {icon}
      {label}
    </span>
  );
}

export default function AdminPage() {
  const addToast = useAppStore((state) => state.addToast);
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && user?.role !== 'admin') {
      router.push('/');
    }
  }, [authLoading, user, router]);

  const [healthStatus, setHealthStatus] = useState<{
    status: string;
    services?: { database: string; redis: string };
    version?: string;
    uptime?: number;
  } | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRestarting, setIsRestarting] = useState<string | null>(null);

  const isAdmin = !authLoading && user?.role === 'admin';

  const fetchInFlightRef = useRef(false);
  const fetchAll = useCallback(async () => {
    if (!isAdmin) return;
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setIsRefreshing(true);
    try {
      const [hRes, qRes] = await Promise.all([
        apiFetch<HealthApiResponse>(`${API_BASE}/api/health`).catch(() => null),
        apiFetch<QueueStatus>(`${API_BASE}/api/admin/queue`).catch(() => null),
      ]);
      if (hRes?.success && 'data' in hRes) setHealthStatus(hRes.data);
      if (qRes?.success && 'data' in qRes) setQueueStatus(qRes.data);
    } finally {
      fetchInFlightRef.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchAll();
    const interval = setInterval(fetchAll, 15_000);
    return () => clearInterval(interval);
  }, [fetchAll, isAdmin]);

  async function handleRestart(jobId: string) {
    setIsRestarting(jobId);
    try {
      const res = await apiFetch(`${API_BASE}/api/admin/queue/${jobId}/restart`, {
        method: 'POST',
        isMutation: true,
      });
      if (res.success) {
        addToast('success', `Job ${jobId.slice(0, 8)}… restarted successfully`);
        await fetchAll();
      } else {
        addToast('error', res.error || 'Failed to restart job');
      }
    } catch {
      addToast('error', 'Failed to restart job — network error');
    } finally {
      setIsRestarting(null);
    }
  }

  const dbStatus = healthStatus?.services?.database === 'connected' ? 'ok' :
    healthStatus?.services?.database === 'disconnected' ? 'error' : 'degraded';
  const redisStatus = healthStatus?.services?.redis === 'connected' ? 'ok' :
    healthStatus?.services?.redis === 'disconnected' ? 'error' : 'degraded';

  if (authLoading || user?.role !== 'admin') {
    return null;
  }

  return (
    <ErrorBoundary>
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Admin Dashboard</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Queue monitoring, DLQ management, and service health
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { setIsRefreshing(true); fetchAll(); }}
          disabled={isRefreshing}
        >
          <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Service Health */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5"
      >
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-[var(--text-secondary)]" />
          <h2 className="font-semibold text-[var(--text-primary)]">Service Health</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-tertiary)]">Status</span>
            <ServiceBadge
              label={healthStatus?.status ?? 'unknown'}
              status={healthStatus?.status === 'healthy' ? 'ok' : healthStatus?.status === 'degraded' ? 'degraded' : 'error'}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-tertiary)]">Database</span>
            <ServiceBadge label={healthStatus?.services?.database ?? 'unknown'} status={dbStatus} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-tertiary)]">Redis</span>
            <ServiceBadge label={healthStatus?.services?.redis ?? 'unknown'} status={redisStatus} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-tertiary)]">Version</span>
            <span className="text-xs font-mono text-[var(--text-secondary)]">
              {healthStatus?.version ?? '—'}
            </span>
          </div>
        </div>
        {healthStatus?.uptime !== undefined && (
          <div className="mt-3 pt-3 border-t border-[var(--border)]">
            <span className="text-xs text-[var(--text-tertiary)]">
              Uptime: {Math.floor(healthStatus.uptime / 60)}m {Math.floor(healthStatus.uptime % 60)}s
            </span>
          </div>
        )}
      </motion.div>

      {/* Queue Stats */}
      {queueStatus && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5"
        >
          <div className="flex items-center gap-2 mb-4">
            <Zap size={16} className="text-[var(--text-secondary)]" />
            <h2 className="font-semibold text-[var(--text-primary)]">Queue Overview</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Waiting', value: queueStatus.queueDepth, icon: Clock, color: 'text-blue-400' },
              { label: 'Active', value: queueStatus.activeJobs, icon: Activity, color: 'text-green-400' },
              { label: 'Completed Today', value: queueStatus.completedToday, icon: CheckCircle, color: 'text-emerald-400' },
              { label: 'Dead Letter Queue', value: queueStatus.dlqDepth, icon: XCircle, color: queueStatus.dlqDepth > 0 ? 'text-red-400' : 'text-[var(--text-secondary)]' },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="flex flex-col gap-1.5 p-3 rounded-xl bg-[var(--bg-primary)]">
                <span className="text-xs text-[var(--text-tertiary)]">{label}</span>
                <div className="flex items-center gap-2">
                  <Icon size={16} className={color} />
                  <span className={`text-2xl font-bold ${color}`}>{value}</span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Dead Letter Queue */}
      {queueStatus && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5"
        >
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={16} className={queueStatus.dlqDepth > 0 ? 'text-red-400' : 'text-[var(--text-secondary)]'} />
            <h2 className="font-semibold text-[var(--text-primary)]">Recent Failures</h2>
            {queueStatus.dlqDepth > 0 && (
              <span className="ml-2 px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-xs font-medium">
                {queueStatus.dlqDepth} total
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw size={20} className="animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : queueStatus.recentFailures.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle size={24} className="text-green-400 mb-2" />
              <p className="text-sm text-[var(--text-secondary)]">No recent failures — all jobs healthy</p>
            </div>
          ) : (
            <div className="space-y-3">
              {queueStatus.recentFailures.map((failure) => (
                <div
                  key={failure.jobId}
                  className="flex items-start justify-between gap-4 p-4 rounded-xl bg-[var(--bg-primary)] border border-[var(--border)]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs text-[var(--text-secondary)]">
                        {failure.jobId.slice(0, 8)}…{failure.jobId.slice(-8)}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-xs">
                        {failure.attemptsMade} attempts
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] mb-1.5 truncate">
                      {failure.failedReason || 'Unknown error'}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-[var(--text-tertiary)]">
                      <span>{failure.genre?.join(', ') || 'unknown genre'}</span>
                      <span>{formatRelativeTime(failure.failedAt)}</span>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRestart(failure.jobId)}
                    disabled={isRestarting === failure.jobId}
                  >
                    {isRestarting === failure.jobId ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    Restart
                  </Button>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
    </ErrorBoundary>
  );
}