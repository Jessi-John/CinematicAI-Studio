'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Menu, User, LogOut, ChevronDown } from 'lucide-react';
import { useStoryCount } from '@/lib/query/stories';
import { useAuth } from '@/lib/auth/auth-context';

interface TopNavProps {
  onMenuClick?: () => void;
  sidebarCollapsed?: boolean;
}

const mainNavItems = [
  { id: 'dashboard', label: 'Dashboard', href: '/' },
  { id: 'create', label: 'Create', href: '/create' },
  { id: 'history', label: 'Generated Stories', href: '/history' },
];

export function TopNav({ onMenuClick }: TopNavProps) {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // isGenerating is no longer in the Zustand store (FE-001 fix).
  // Use useGeneration hook in components that need this state.
  // P3: Use a lightweight count-only query instead of fetching ALL stories
  // just to display a badge count. Previously useStories() downloaded the
  // full story list (with episodes/scenes) on every page nav and window focus.
  const { data: storyCount = 0 } = useStoryCount();
  const { user, logout } = useAuth();
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu on outside click or Escape
  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClickOutside = (e: MouseEvent): void => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [userMenuOpen]);

  const handleLogout = useCallback(async (): Promise<void> => {
    setUserMenuOpen(false);
    try {
      await logout();
    } catch {
      // logout errors are non-fatal here — AuthProvider handles redirect
    }
  }, [logout]);

  // Keyboard navigation for the user menu.
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!userMenuOpen) return;
    const items = Array.from(
      userMenuRef.current?.querySelectorAll('[role="menuitem"]') ?? []
    ) as HTMLElement[];
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = index >= 0 ? (index + 1) % items.length : 0;
      items[next]!.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = index > 0 ? index - 1 : items.length - 1;
      items[prev]!.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]!.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]!.focus();
    }
  }, [userMenuOpen]);

  // L4-AVATAR: render a proper user icon (instead of "?") while the
  // auth context is bootstrapping. The "?" was a placeholder for the
  // first letter of the username, but the user object is null
  // between page load and /api/auth/me returning. Showing a
  // recognizable user icon during that window avoids the "?" that
  // looked like a broken page. Once the user is loaded, the icon
  // swaps to the initial letter.
  const userInitial = user?.username?.charAt(0).toUpperCase();
  const username = user?.username ?? 'Guest';

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className={`fixed top-0 left-0 right-0 h-16 z-50 transition-all duration-200 ${
        isScrolled
          ? 'bg-[var(--bg-secondary)]/95 backdrop-blur-xl shadow-lg shadow-black/10'
          : 'bg-[var(--bg-secondary)]/80 backdrop-blur-xl'
      } border-b border-[var(--border)]`}
    >
      <div className="h-full px-4 flex items-center justify-between">
        {/* Left Section */}
        <div className="flex items-center gap-4">
          {/* Mobile Menu Button */}
          <button
            type="button"
            onClick={onMenuClick}
            className="md:hidden p-2 hover:bg-white/10 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
            aria-label="Open navigation menu"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded-lg">
            <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            <span className="text-lg font-bold gradient-text hidden sm:block">
              CinematicAI
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1 ml-4" aria-label="Main navigation">
            {mainNavItems.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                    isActive
                      ? 'text-white bg-purple-500/20'
                      : 'text-[var(--text-secondary)] hover:text-white hover:bg-white/5'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-2">
          {/* Stats Badge — derived from TanStack Query */}
          {storyCount > 0 && (
            <div className="hidden lg:flex items-center gap-1 px-3 py-1.5 bg-[var(--bg-tertiary)] rounded-full text-xs">
              <span className="text-[var(--text-tertiary)]">Stories:</span>
              <span className="text-white font-medium">{storyCount}</span>
            </div>
          )}

          {/* User Menu — dropdown with logout */}
          <div className="relative" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label={`User menu for ${username}`}
              className="flex items-center gap-1.5 pl-1 pr-2 h-9 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] hover:border-purple-500 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
            >
              <span className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-semibold">
                {userInitial ?? <User className="w-4 h-4" aria-hidden="true" />}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-[var(--text-secondary)] transition-transform ${
                  userMenuOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>
            <AnimatePresence>
              {userMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.97 }}
                  transition={{ duration: 0.12 }}
                  role="menu"
                  aria-label="User menu"
                  onKeyDown={handleMenuKeyDown}
                  className="absolute right-0 top-11 w-56 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl py-2 z-50"
                >
                  <div className="px-4 py-2 border-b border-[var(--border)]">
                    <p className="text-sm font-medium truncate">{username}</p>
                    <p className="text-xs text-[var(--text-tertiary)] truncate">
                      {user?.role ?? 'user'}
                    </p>
                  </div>
                  <Link
                    href="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    role="menuitem"
                    className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none focus-visible:bg-white/5"
                  >
                    <User className="w-4 h-4" aria-hidden="true" />
                    Settings
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    role="menuitem"
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none focus-visible:bg-red-500/10"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    Sign out
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.header>
  );
}