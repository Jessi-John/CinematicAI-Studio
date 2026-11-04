'use client';

import { usePathname } from 'next/navigation';
import { TopNav } from '@/components/layout/top-nav';
import { Sidebar } from '@/components/layout/sidebar';
import { MobileNav, MobileHeader } from '@/components/layout/mobile-nav';
import { ToastContainer } from '@/components/ui/toast';
import { ErrorBoundary } from '@/components/error-boundary';
import { useAppStore } from '@/lib/stores/app-store';

interface AppShellProps {
  children: React.ReactNode;
}

const PUBLIC_AUTH_ROUTES = new Set(['/login', '/register']);

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  if (PUBLIC_AUTH_ROUTES.has(pathname)) {
    return (
      <>
        <ErrorBoundary>{children}</ErrorBoundary>
        <ToastContainer />
      </>
    );
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[60] focus:px-4 focus:py-2 focus:bg-purple-600 focus:text-white focus:rounded-lg focus:outline-none"
      >
        Skip to main content
      </a>

      {/* Mobile Header */}
      <MobileHeader />

      {/* Desktop Top Nav */}
      <div className="hidden md:block">
        <TopNav
          onMenuClick={toggleSidebar}
          sidebarCollapsed={sidebarCollapsed}
        />
      </div>

      {/* Sidebar */}
      <div className="hidden md:block">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
        />
      </div>

      {/* Main Content */}
      <main
        id="main-content"
        className={`min-h-screen transition-all duration-200 ${
          sidebarCollapsed ? 'md:pl-16' : 'md:pl-60'
        } pt-14 md:pt-16`}
      >
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>

      {/* Mobile Bottom Nav */}
      <MobileNav />

      {/* Toast Notifications — wrapped in ErrorBoundary so a toast render error
          doesn't crash the entire app shell. Toasts are non-critical UI. */}
      <ErrorBoundary><ToastContainer /></ErrorBoundary>
    </>
  );
}