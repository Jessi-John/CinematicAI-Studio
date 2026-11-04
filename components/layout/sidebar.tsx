'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Plus,
  History,
  Settings,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Film,
  Clock,
  Shield,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppStore } from '@/lib/stores/app-store';
import { useRecentStories } from '@/lib/query/stories';
import { useAuth } from '@/lib/auth/auth-context';
import { GENRES } from '@/lib/constants/genres';
import type { Genre } from '@/types';

interface NavItem {
  id: string;
  label: string;
  icon: typeof LayoutDashboard;
  href: string;
}

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/' },
  { id: 'create', label: 'Create', icon: Plus, href: '/create' },
  { id: 'history', label: 'Generated Stories', icon: History, href: '/history' },
  { id: 'admin', label: 'Admin', icon: Shield, href: '/admin' },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
];

// Show ALL genres with scrolling so users can access any genre from the sidebar.
// Fix: Previously only the first 8 of 21 genres were shown, hiding 13 genres
// from quick access. Now all 21 genres are displayed with a scroll container.
const quickGenres: readonly { value: Genre; label: string; emoji: string }[] = GENRES;

export function Sidebar({ collapsed = false, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const setFilterGenre = useAppStore((state) => state.setFilterGenre);
  const filterGenre = useAppStore((state) => state.filterGenre);
  const { user } = useAuth();
  // Uses dedicated recent-stories query that fetches only 3 items.
  // Fix: Previously used useStories() which fetched all stories (100+).
  const { data: recentStories = [] } = useRecentStories();

  const handleGenreClick = (genre: Genre) => {
    setFilterGenre(genre === filterGenre ? null : genre);
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="fixed left-0 top-16 h-[calc(100vh-64px)] bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col z-40"
    >
      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.filter((item) => item.id !== 'admin' || user?.role === 'admin').map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                isActive
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'text-[var(--text-secondary)] hover:text-white hover:bg-white/5'
              }`}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
              {!collapsed && (
                <span className="text-sm font-medium truncate">{item.label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Quick Genres */}
      {!collapsed && (
        <div className="p-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)] uppercase tracking-wider">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            <span>Quick Genres</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 max-h-[280px] overflow-y-auto" role="group" aria-label="Quick genre filters">
            {quickGenres.map((genre) => (
              <button
                key={genre.value}
                type="button"
                aria-pressed={filterGenre === genre.value}
                onClick={() => handleGenreClick(genre.value)}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-all focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                  filterGenre === genre.value
                    ? 'bg-purple-500/30 text-purple-300 border border-purple-500/50'
                    : 'text-[var(--text-tertiary)] hover:text-white hover:bg-white/5'
                }`}
              >
                <span aria-hidden="true">{genre.emoji}</span>
                <span className="truncate">{genre.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent Stories */}
      {!collapsed && recentStories.length > 0 && (
        <div className="p-3 border-t border-[var(--border)]">
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)] uppercase tracking-wider">
            <Clock className="w-4 h-4" aria-hidden="true" />
            <span>Recent</span>
          </div>
          <div className="mt-2 space-y-1 max-h-[100px] overflow-y-auto">
            {recentStories.map((story) => (
              <Link
                key={story.id}
                href={`/story/${story.id}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:text-white hover:bg-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
              >
                <Film className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{story.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Collapse Toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-full flex items-center justify-center hover:border-purple-500 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
      >
        {collapsed ? (
          <ChevronRight className="w-3 h-3" aria-hidden="true" />
        ) : (
          <ChevronLeft className="w-3 h-3" aria-hidden="true" />
        )}
      </button>
    </motion.aside>
  );
}