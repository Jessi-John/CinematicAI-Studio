'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import type { ReactNode } from 'react';

interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const loginUrl = new URL('/login', window.location.origin);
      loginUrl.searchParams.set('from', pathname);
      router.push(loginUrl.toString());
    }
  }, [isLoading, isAuthenticated, router, pathname]);

  if (isLoading) return null;
  if (!isAuthenticated) return null;

  return <>{children}</>;
}
