'use client';

import { RequireAuth } from '@/lib/auth/require-auth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
