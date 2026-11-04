'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  Film,
  Clock,
  Sparkles,
  TrendingUp,
  Plus,
  Play,
  Search,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Story } from '@/types';
import { GENRES, GENRE_MAP, STORY_COLORS } from '@/lib/constants/genres';

interface DashboardHeaderProps {
  onCreateClick?: () => void;
}

export function DashboardHeader({
  onCreateClick,
}: DashboardHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-8"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">Story Dashboard</h1>
          <p className="text-[var(--text-secondary)]">
            Create and manage your cinematic AI-generated stories
          </p>
        </div>
        <Button onClick={onCreateClick} size="lg" className="shrink-0" data-testid="create-story-btn">
          <Plus className="w-5 h-5 mr-2" />
          Create Story
        </Button>
      </div>
    </motion.div>
  );
}

interface StatsGridProps {
  stats: {
    totalStories: number;
    totalEpisodes: number;
    totalScenes: number;
    avgVirality: number;
  };
}

export function StatsGrid({ stats }: StatsGridProps) {
  const statItems = [
    {
      label: 'Total Stories',
      value: stats.totalStories,
      icon: Film,
      color: 'purple',
      description: 'Created stories',
    },
    {
      label: 'Episodes',
      value: stats.totalEpisodes,
      icon: Clock,
      color: 'blue',
      description: 'Across loaded stories',
    },
    {
      label: 'Total Scenes',
      value: stats.totalScenes,
      icon: Sparkles,
      color: 'pink',
      description: 'Across loaded stories',
    },
    {
      label: 'Avg Virality',
      value: `${stats.avgVirality}%`,
      icon: TrendingUp,
      color: 'green',
      description: 'Across loaded stories',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {statItems.map((stat, idx) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.05 }}
          className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                stat.color === 'purple'
                  ? 'bg-purple-500/20 text-purple-400'
                  : stat.color === 'blue'
                  ? 'bg-blue-500/20 text-blue-400'
                  : stat.color === 'pink'
                  ? 'bg-pink-500/20 text-pink-400'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              <stat.icon className="w-5 h-5" aria-hidden="true" />
            </div>
            <span className="text-sm text-[var(--text-secondary)]">
              {stat.label}
            </span>
          </div>
          <div className="text-2xl font-bold">{stat.value}</div>
          <div className="text-xs text-[var(--text-tertiary)]">
            {stat.description}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

interface SearchFiltersProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterGenre: string | null;
  onFilterGenreChange: (genre: string | null) => void;
  onCreateClick: () => void;
}

export function SearchFiltersBar({
  searchQuery,
  onSearchChange,
  filterGenre,
  onFilterGenreChange,
  onCreateClick,
}: SearchFiltersProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="flex flex-col md:flex-row gap-4 mb-6"
    >
      {/* Search Input */}
      <div className="flex-1 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" aria-hidden="true" />
        <input
          id="story-search"
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search stories..."
          aria-label="Search stories"
          className="w-full pl-10 pr-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-purple-500 transition-colors"
        />
      </div>

      {/* Genre Filter */}
      <select
        aria-label="Filter stories by genre"
        value={filterGenre || ''}
        onChange={(e) =>
          onFilterGenreChange(e.target.value || null)
        }
        className="px-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-purple-500 min-w-[160px]"
      >
        <option value="">All Genres</option>
        {GENRES.map((g) => (
          <option key={g.value} value={g.value}>
            {g.emoji} {g.label}
          </option>
        ))}
      </select>

      {/* Create Button */}
      <Button onClick={onCreateClick} className="md:hidden">
        <Plus className="w-4 h-4 mr-2" />
        Create
      </Button>
    </motion.div>
  );
}

interface StoryGridProps {
  stories: Story[];
  isLoading?: boolean;
  isError?: boolean;
  hasMore?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  onCreateClick?: () => void;
}

export function StoryGrid({
  stories,
  isLoading,
  isError,
  hasMore,
  isFetchingNextPage,
  onLoadMore,
  onCreateClick,
}: StoryGridProps) {
  // Fix: Handle error state. Previously only loading and empty states were
  // checked, so a network failure showed the empty state ("No stories found")
  // instead of an error message, misleading users into thinking there are
  // genuinely no stories.
  if (isError) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-secondary)] mb-2">
          Failed to load stories
        </h3>
        <p className="text-sm text-[var(--text-tertiary)] mb-4">
          There was a problem fetching your stories. Please try again.
        </p>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <StoryCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (stories.length === 0) {
    return <EmptyState onCreateClick={onCreateClick ?? (() => {})} />;
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {stories.map((story, idx) => (
          <StoryCard key={story.id} story={story} index={idx} />
        ))}
      </div>
      {hasMore && onLoadMore && (
        <div className="mt-8 flex justify-center">
          <Button
            variant="secondary"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

interface StoryCardProps {
  story: Story;
  index: number;
}

function qualityGradeColor(grade?: string): string {
  switch (grade) {
    case 'A': return '#22c55e';
    case 'B': return '#3b82f6';
    case 'C': return '#f59e0b';
    case 'D': return '#f97316';
    case 'F': return '#ef4444';
    default: return '#6b7280';
  }
}

export function StoryCard({ story, index }: StoryCardProps) {
  const genre = GENRE_MAP[story.genre] ?? null;
  const genreColor = STORY_COLORS[story.genre] ?? STORY_COLORS.fantasy;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
    >
      <Link
        href={`/story/${story.id}`}
        className="block group focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded-xl"
      >
        <div className="relative bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-xl overflow-hidden transition-all duration-200 group-hover:border-purple-500/50 group-hover:shadow-lg group-hover:shadow-purple-500/10">
          {/* Thumbnail Area */}
          <div
            className="h-32 relative overflow-hidden"
            style={{
              background: `linear-gradient(135deg, ${genreColor}22, ${genreColor}44)`,
            }}
          >
            <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-tertiary)] to-transparent" />

            {/* Genre Badge */}
            <div className="absolute top-3 left-3">
              <span
                className="px-2 py-1 rounded-md text-xs font-medium backdrop-blur-sm"
                style={{
                  backgroundColor: `${genreColor}33`,
                  color: genreColor,
                  border: `1px solid ${genreColor}66`,
                }}
              >
                {genre?.emoji} {genre?.label}
              </span>
            </div>

            {/* Play Button */}
            <div className="absolute bottom-3 right-3">
              <div className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center group-hover:bg-purple-500 transition-colors">
                <Play className="w-4 h-4 text-white ml-0.5" aria-hidden="true" />
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="p-4">
            <h3 className="font-semibold text-white mb-2 line-clamp-1">
              {story.title}
            </h3>

            <div className="flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
              <span className="flex items-center gap-1">
                <Film className="w-3.5 h-3.5" aria-hidden="true" />
                {story.episodeCount ?? story.episodes.length} Episodes
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                ~{Math.floor((story.episodeCount ?? story.episodes.length) * 50 / 60)} min
              </span>
            </div>

            {/* Quality Badge */}
            {(story.qualityScore ?? story.metadata?.qualityScore) && (
              <div className="mt-3 mb-1 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400">
                  Quality: {story.qualityScore ?? story.metadata?.qualityScore}/100
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                  style={{
                    backgroundColor: qualityGradeColor(story.qualityGrade ?? story.metadata?.qualityGrade),
                    color: '#000',
                  }}
                >
                  {story.qualityGrade ?? story.metadata?.qualityGrade}
                </span>
              </div>
            )}
            {/* Virality Progress */}
            {story.metadata && (
              <div className="mt-1 flex items-center gap-2">
                <div className="flex-1 h-1 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${story.metadata.viralityScore ?? 0}%`,
                    background: `linear-gradient(90deg, ${genreColor}, ${genreColor}88)`,
                  }}
                />
                </div>
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {story.metadata.viralityScore ?? 0}% viral
                </span>
              </div>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

export function StoryCardSkeleton() {
  return (
    <div className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-xl overflow-hidden" aria-busy="true" aria-label="Loading story">
      <div className="h-32 bg-[var(--bg-secondary)] animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 bg-[var(--bg-secondary)] rounded animate-pulse w-3/4" />
        <div className="flex gap-4">
          <div className="h-3 bg-[var(--bg-secondary)] rounded animate-pulse w-16" />
          <div className="h-3 bg-[var(--bg-secondary)] rounded animate-pulse w-16" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="text-center py-16"
    >
      <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center">
        <Film className="w-10 h-10 text-[var(--text-tertiary)]" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-semibold mb-2">No stories yet</h3>
      <p className="text-[var(--text-secondary)] mb-2 max-w-md mx-auto">
        Create AI-generated cinematic stories for YouTube Shorts — each with 10 episodes,
        image prompts, video prompts, and SEO optimization.
      </p>
      <p className="text-sm text-[var(--text-tertiary)] mb-6 max-w-md mx-auto">
        Pick a genre, optionally add a story seed, and let AI do the rest.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Button size="lg" onClick={onCreateClick}>
          <Sparkles className="w-5 h-5 mr-2" aria-hidden="true" />
          Create Your First Story
        </Button>
      </div>
    </motion.div>
  );
}

// Fix #41: removed the local `Search` SVG component. It duplicated
// `Search` from `lucide-react`, which is already a dependency. Use the
// imported `Search` directly at the call sites.