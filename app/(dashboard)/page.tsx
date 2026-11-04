/**
 * L4-DASHBOARD-ARCH: Client Component (retained).
 *
 * Evaluation: The page is dominated by client state and live interactivity
 * (debounced search, genre filter, generation modal, SSE progress streaming,
 * toast notifications). SEO is irrelevant because the route is authenticated.
 * Converting it to a Server Component would leave only a thin server shell;
 * the measurable payoff does not justify the refactor risk.
 */
'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  DashboardHeader,
  StatsGrid,
  SearchFiltersBar,
  StoryGrid,
} from '@/components/dashboard/dashboard-components';
import dynamic from 'next/dynamic';
import { useAppStore } from '@/lib/stores/app-store';
import { useInfiniteStories } from '@/lib/query/stories';
import { useGeneration } from '@/hooks/use-generation';
import { ErrorBoundary } from '@/components/error-boundary';
import type { Story, Genre } from '@/types';

const LazyGenerationModal = dynamic(
  () => import('@/components/dashboard/generation-modal').then((m) => m.GenerationModal),
  { ssr: false }
);

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const filterGenre = useAppStore((state) => state.filterGenre);
  const setFilterGenre = useAppStore((state) => state.setFilterGenre);
  const addToast = useAppStore((state) => state.addToast);

  // P1: Debounce searchQuery by 300ms before it reaches useStories so each
  // keystroke doesn't trigger a fresh backend request. A 10-char search
  // previously fired 10 requests; now it fires 1 after typing stops.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fix: Check isError to show error state. Previously only isLoading was checked,
  // so a network failure showed an empty "No stories" state instead of an error.
  // Fix M10: Pass search/genre filters to useStories for server-side filtering.
  // When filters change, the query key changes and TanStack Query auto-refetches.
  const {
    stories,
    total,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteStories(debouncedSearch, filterGenre);
  const [showGenModal, setShowGenModal] = useState(false);

  const { generate, isGenerating, progress, error, reset } = useGeneration({
    onSuccess: (story: Story) => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
      addToast('success', 'Story generated successfully!');
      setShowGenModal(false);
      router.push(`/story/${story.id}`);
    },
    onError: (msg: string) => {
      addToast('error', msg);
    },
  });

  // P2: Memoize derived stats so they're only recomputed when stories changes,
  // not on every render/keystroke. For 100+ stories, the 3x reduce passes add
  // measurable jank on every state change.
  // M30: Use cached episodeCount/sceneCount from the list-view payload
  // (populated at save time). Falls back to episodes[] length when the
  // cached counts are absent (older API responses).
  const stats = useMemo(() => ({
    // PAG-2: totalStories comes from the API total so the stat is accurate
    // even when only the first page has been loaded.
    totalStories: total,
    // M42: episodes/scenes/virality are computed from the LOADED pages only —
    // the API doesn't expose aggregates, so these are estimates for the
    // loaded subset, labeled as such in the UI.
    totalEpisodes: stories.reduce(
      (acc, s) => acc + (s.episodeCount ?? s.episodes.length),
      0
    ),
    totalScenes: stories.reduce(
      (acc, s) => acc + (s.sceneCount ?? s.episodes.reduce((a, e) => a + e.scenes.length, 0)),
      0
    ),
    avgVirality:
      stories.length > 0
        ? Math.round(
            stories.reduce((acc, s) => acc + (s.metadata?.viralityScore || 0), 0) /
              stories.length
          )
        : 0,
  }), [stories, total]);

  const handleGenerate = (genres: Genre[], seed: string): void => {
    void generate({ genre: genres, seed: seed || undefined });
  };

  const handleClose = (): void => {
    if (isGenerating) return;
    setShowGenModal(false);
    reset();
  };

  // Minimize: close the modal but keep generation running. The useGeneration
  // hook lives in this page, so it survives the modal closing; onSuccess still
  // fires (toast + redirect) when generation completes.
  const handleMinimize = (): void => {
    setShowGenModal(false);
  };

  return (
    <ErrorBoundary>
    <div className="min-h-screen pb-20 md:pb-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <DashboardHeader onCreateClick={() => setShowGenModal(true)} />

        <StatsGrid stats={stats} />

        <SearchFiltersBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          filterGenre={filterGenre}
          onFilterGenreChange={setFilterGenre}
          onCreateClick={() => setShowGenModal(true)}
        />

        <StoryGrid
          stories={stories}
          isLoading={isLoading}
          isError={isError}
          hasMore={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          onCreateClick={() => setShowGenModal(true)}
        />

        {error && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center justify-between">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => {
                reset();
                requestAnimationFrame(() => setShowGenModal(true));
              }}
              className="ml-4 px-3 py-1.5 text-sm bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <LazyGenerationModal
        isOpen={showGenModal}
        onClose={handleClose}
        onMinimize={handleMinimize}
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
        progress={progress}
      />
    </div>
    </ErrorBoundary>
  );
}
