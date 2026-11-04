'use client';

import { create } from 'zustand';

type ToastType = 'success' | 'error' | 'info';

interface ToastEntry {
  id: string;
  type: ToastType;
  message: string;
}

interface AppState {
  sidebarCollapsed: boolean;
  searchQuery: string;
  filterGenre: string | null;

  toasts: ToastEntry[];

  toggleSidebar: () => void;
  setSearchQuery: (query: string) => void;
  setFilterGenre: (genre: string | null) => void;

  addToast: (type: ToastType, message: string) => void;
  removeToast: (id: string) => void;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  searchQuery: '',
  filterGenre: null,

  toasts: [],

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterGenre: (genre) => set({ filterGenre: genre }),

  addToast: (type, message) => {
    const id = makeId();
    set((state) => {
      const existing = state.toasts.find((t) => t.message === message);
      if (existing) {
        return state; // deduplicate identical messages
      }
      // Cap toasts at 25 to prevent unbounded array growth under error storms
      const next = state.toasts.length >= 25
        ? state.toasts.slice(-24)
        : state.toasts;
      return { toasts: [...next, { id, type, message }] };
    });
    return id;
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));
