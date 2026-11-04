'use client';

import { motion } from 'framer-motion';
import { Eye, Play } from 'lucide-react';
import type { Story } from '@/types';
import { GENRE_MAP, STORY_COLORS } from '@/lib/constants/genres';
import { EpisodeCardCompact } from '@/components/story/episode-card';

interface GenerationPreviewProps {
  story: Story;
  onViewStory?: () => void;
}

export function GenerationPreview({ story, onViewStory }: GenerationPreviewProps) {
  const genre = GENRE_MAP[story.genre] ?? null;
  const genreColor = STORY_COLORS[story.genre];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl overflow-hidden"
    >
      <div
        className="p-6 border-b border-[var(--border)]"
        style={{
          background: `linear-gradient(135deg, ${genreColor}22, ${genreColor}11)`,
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium mb-3"
              style={{
                backgroundColor: `${genreColor}33`,
                color: genreColor,
              }}
            >
              {genre?.emoji} {genre?.label}
            </span>
            <h2 className="text-2xl font-bold mb-2">{story.title}</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {story.episodes.length} Episodes • ~{Math.floor(story.episodes.length * 50 / 60)} minutes total
            </p>
          </div>
          <motion.button
            onClick={onViewStory}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-2 px-4 py-2 gradient-bg rounded-lg font-medium text-sm"
          >
            <Play className="w-4 h-4" />
            View Story
          </motion.button>
        </div>

        {story.metadata && (
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="p-3 bg-black/20 rounded-lg">
              <div className="text-2xl font-bold text-purple-400">{story.metadata.viralityScore ?? 0}%</div>
              <div className="text-xs text-[var(--text-tertiary)]">Virality Score</div>
            </div>
            <div className="p-3 bg-black/20 rounded-lg">
              <div className="text-2xl font-bold text-purple-400">{story.metadata.monetizationScore ?? 0}%</div>
              <div className="text-xs text-[var(--text-tertiary)]">Monetization</div>
            </div>
            <div className="p-3 bg-black/20 rounded-lg">
              <div className="text-2xl font-bold text-purple-400">{story.metadata.targetAudience}</div>
              <div className="text-xs text-[var(--text-tertiary)]">Target Audience</div>
            </div>
          </div>
        )}
      </div>

      <div className="p-6">
        <h4 className="text-sm font-medium text-[var(--text-secondary)] mb-4 flex items-center gap-2">
          <Eye className="w-4 h-4" />
          Episode Overview
        </h4>
        <div className="space-y-2">
          {story.episodes.slice(0, 5).map((episode, idx) => (
            <EpisodeCardCompact key={episode.id} episode={episode} index={idx} />
          ))}
          {story.episodes.length > 5 && (
            <div className="text-center py-2 text-sm text-[var(--text-tertiary)]">
              +{story.episodes.length - 5} more episodes
            </div>
          )}
        </div>
      </div>

      <div className="px-6 pb-6">
        <h4 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Characters</h4>
        <div className="flex flex-wrap gap-2">
          {story.characters.map((character) => (
            <div
              key={character.id}
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-full text-sm"
            >
              <span className="text-purple-400 mr-1">•</span>
              {character.name}
              <span className="text-xs text-[var(--text-tertiary)] ml-2">{character.role}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}