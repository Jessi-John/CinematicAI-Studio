/**
 * L4-HISTORY-ARCH: Client Component (retained).
 *
 * Evaluation: Although this is a list view, its filter state lives in shared
 * Zustand state rather than URL params. Server-rendering the unfiltered list
 * would cause a hydration flash when the client re-fetches with the active
 * filter. Moving filters to URL params would be a larger refactor with
 * navigation/caching risks; the current client architecture is kept because
 * the user-facing benefit does not outweigh the regression risk.
 */
'use client';

import { useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, Film, AlertCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/lib/stores/app-store';
import { useInfiniteStories } from '@/lib/query/stories';
import { StoryCard, StoryCardSkeleton } from '@/components/dashboard/dashboard-components';
import { Button } from '@/components/ui/button';
import { GENRES } from '@/lib/constants/genres';

export default function HistoryPage() {
  const queryClient = useQueryClient();
  const handleRetry = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stories'] });
  }, [queryClient]);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const filterGenre = useAppStore((state) => state.filterGenre);
  const setFilterGenre = useAppStore((state) => state.setFilterGenre);

  // P1: Debounce search for the same reason as the dashboard.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'title'>('newest');
  // M41: Sort is now server-side via the sortBy parameter passed to
  // useInfiniteStories. The backend uses a composite cursor so every page is
  // ordered deterministically across the whole library, not just the subset
  // already loaded on the client.

  const {
    stories,
    total,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteStories(debouncedSearch, filterGenre, sortBy);

  return (
    <div className="min-h-screen pb-20 md:pb-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Generated Stories</h1>
          <p className="text-[var(--text-secondary)]">
            View all your AI-generated stories with prompts and content
          </p>
        </motion.div>

        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by title or seed..."
                className="w-full pl-10 pr-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-purple-500"
                aria-label="Search stories"
              />
            </div>
          </div>
          <Button variant="secondary" onClick={() => setShowFilters(!showFilters)} className="focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none">
            <Filter className="w-4 h-4 mr-2" aria-hidden="true" />
            Filters
          </Button>
        </div>

        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mb-6 p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
          >
            <fieldset>
              <legend className="text-sm font-medium text-[var(--text-secondary)] mb-3 block">
                Filter by Genre
              </legend>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by genre">
                <button
                  type="button"
                  aria-pressed={!filterGenre}
                  onClick={() => setFilterGenre(null)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                    !filterGenre
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-white'
                  }`}
                >
                  All Genres
                </button>
                {GENRES.map((genre) => (
                  <button
                    type="button"
                    key={genre.value}
                    aria-pressed={filterGenre === genre.value}
                    onClick={() => setFilterGenre(genre.value)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                      filterGenre === genre.value
                        ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-white'
                    }`}
                  >
                    <span aria-hidden="true">{genre.emoji}</span> {genre.label}
                  </button>
                ))}
              </div>
            </fieldset>
          </motion.div>
        )}

        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-[var(--text-secondary)]">
            {total} {total === 1 ? 'story' : 'stories'} found
          </p>
          <select
            className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            aria-label="Sort stories"
            title="Sort all stories"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="title">By Title</option>
          </select>
        </div>

        {isError ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
              <AlertCircle className="w-10 h-10 text-red-400" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Failed to load stories</h3>
            <p className="text-[var(--text-secondary)] mb-6">
              An error occurred while fetching your stories. Please try again.
            </p>
            <Button onClick={handleRetry}>
              <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
              Retry
            </Button>
          </motion.div>
        ) : isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true" aria-live="polite" role="status">
            <span className="sr-only">Loading stories</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <StoryCardSkeleton key={i} />
            ))}
          </div>
        ) : stories.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center">
              <Film className="w-10 h-10 text-[var(--text-tertiary)]" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No stories found</h3>
            <p className="text-[var(--text-secondary)] mb-6">
              {searchQuery || filterGenre
                ? 'Try adjusting your search or filters'
                : 'Create your first story to see it here'}
            </p>
            <Link href="/create">
              <Button>Create New Story</Button>
            </Link>
          </motion.div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {stories.map((story, idx) => (
                <StoryCard key={story.id} story={story} index={idx} />
              ))}
            </div>
            {hasNextPage && (
              <div className="mt-8 flex justify-center">
                <Button
                  variant="secondary"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
