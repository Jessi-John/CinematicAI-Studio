'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '@/lib/stores/app-store';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

const MAX_TOASTS = 5;
const TOAST_DURATION_MS = 5000;

export function ToastContainer() {
  const toasts = useAppStore((state) => state.toasts);
  const visible = toasts.slice(-MAX_TOASTS);
  const assertive = visible.filter((t) => t.type === 'error');
  const polite = visible.filter((t) => t.type !== 'error');

  return (
    // Single positioned wrapper so the two live regions STACK vertically
    // instead of both sitting at top-4 right-4 and overlapping when an error
    // toast and a success/info toast are visible at the same time. The two
    // regions remain separate so errors stay aria-live="assertive" and the
    // rest "polite".
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      <div
        className="flex flex-col gap-2"
        role="region"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertive.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <div
        className="flex flex-col gap-2"
        role="region"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useAppStore((state) => state.removeToast);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => removeToast(toast.id), TOAST_DURATION_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [removeToast, toast.id]);

  const bgColors = {
    success: 'bg-emerald-500/20 border-emerald-500',
    error: 'bg-red-500/20 border-red-500',
    info: 'bg-purple-500/20 border-purple-500',
  };

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm animate-slide-in-right ${bgColors[toast.type]}`}
    >
      <span className="text-sm">{toast.message}</span>
      <button
        type="button"
        onClick={() => removeToast(toast.id)}
        className="p-1 hover:bg-white/10 rounded transition-colors focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}