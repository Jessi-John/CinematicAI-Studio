'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Plus,
  History,
  Settings,
  Sparkles,
  Shield,
} from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';

const navItems = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard, href: '/' },
  { id: 'create', label: 'Create', icon: Plus, href: '/create' },
  { id: 'history', label: 'Generated', icon: History, href: '/history' },
  { id: 'admin', label: 'Admin', icon: Shield, href: '/admin' },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
];

export function MobileNav() {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--bg-secondary)]/95 backdrop-blur-xl border-t border-[var(--border)] z-50 md:hidden">
      <div className="h-full flex items-center justify-around">
        {navItems.filter((item) => item.id !== 'admin' || user?.role === 'admin').map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg transition-all ${
                isActive ? 'text-purple-400' : 'text-[var(--text-tertiary)]'
              }`}
            >
              <item.icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function MobileHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-[var(--bg-secondary)]/95 backdrop-blur-xl border-b border-[var(--border)] z-50 md:hidden">
      <div className="h-full px-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <span className="text-lg font-bold gradient-text">CinematicAI</span>
        </Link>
      </div>
    </header>
  );
}