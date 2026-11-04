'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';

// C4 — React Query DevTools (development only). Dynamic import prevents
// the devtools bundle from being included in production builds.
const ReactQueryDevtoolsProduction = dynamic(() =>
  import('@tanstack/react-query-devtools/production').then((mod) => ({
    default: mod.ReactQueryDevtools,
  }))
);

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes
            gcTime: 1000 * 60 * 30, // 30 minutes (formerly cacheTime)
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtoolsProduction />
      )}
    </QueryClientProvider>
  );
}

// Re-export for use in components
export { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
export type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';