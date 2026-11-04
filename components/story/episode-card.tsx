'use client';

import { motion } from 'framer-motion';
import { Play, Clock, ChevronRight, Film, Mic, RefreshCw } from 'lucide-react';
import type { Episode } from '@/types';

interface EpisodeCardProps {
  episode: Episode;
  index: number;
  storyTitle: string;
  onClick?: () => void;
  onRegenerate?: () => void;
  isRegenerating?: boolean;
}

export function EpisodeCard({
  episode,
  index,
  onClick,
  onRegenerate,
  isRegenerating,
}: EpisodeCardProps) {
  const previewNarration = episode.scenes[0]?.narration?.text || '';

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
    >
      {/* MEDIUM #43: the card body is a single semantic button. The regenerate
          action is moved outside of it so we no longer nest a <button> inside
          a role="button" element. */}
      <div className="group flex items-start gap-4 p-4 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-xl transition-all duration-200 hover:border-purple-500/50 hover:bg-purple-500/5">
        <button
          type="button"
          onClick={onClick}
          disabled={!onClick}
          aria-label={`Episode ${episode.number}: ${episode.title}`}
          className="flex-1 flex items-start gap-4 min-w-0 text-left disabled:cursor-default focus:outline-none focus:ring-2 focus:ring-purple-500/50 rounded-xl"
        >
          <div className="relative shrink-0">
            <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-purple-500/20 to-purple-500/5 border border-purple-500/20 flex items-center justify-center">
              <span className="text-2xl font-bold text-purple-400">{episode.number}</span>
            </div>
            <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center">
              <Play className="w-3 h-3 text-purple-400 ml-0.5" />
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <h4 className="font-semibold text-white truncate">{episode.title}</h4>
                <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-tertiary)]">
                  <span className="flex items-center gap-1">
                    <Film className="w-3.5 h-3.5" />
                    {episode.scenes.length} scenes
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    ~{episode.duration}s
                  </span>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-[var(--text-tertiary)] group-hover:text-purple-400 transition-colors shrink-0" />
            </div>

            <p className="text-sm text-purple-400 font-medium mb-2 line-clamp-2">{episode.hook}</p>

            {previewNarration && (
              <div className="flex items-start gap-2 p-2 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
                <Mic className="w-4 h-4 text-pink-400 mt-0.5 shrink-0" />
                <p className="text-xs text-[var(--text-secondary)] line-clamp-2 italic">
                  &ldquo;{previewNarration}&rdquo;
                </p>
              </div>
            )}

            <p className="text-xs text-[var(--text-tertiary)] mt-2 line-clamp-2">
              <span className="text-orange-400">Cliffhanger:</span> {episode.cliffhanger}
            </p>
          </div>
        </button>

        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={isRegenerating}
            className="shrink-0 self-start p-1.5 rounded-md hover:bg-white/10 text-[var(--text-tertiary)] hover:text-purple-300 transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            title="Regenerate this episode"
            aria-label={`Regenerate episode ${episode.number}`}
          >
            <RefreshCw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

export function EpisodeCardCompact({ episode, index }: { episode: Episode; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className="flex items-center gap-3 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] hover:border-purple-500/30 transition-colors"
    >
      <div className="w-8 h-8 rounded-md bg-purple-500/20 flex items-center justify-center">
        <span className="text-sm font-bold text-purple-400">{episode.number}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white truncate">{episode.title}</div>
        <div className="text-xs text-[var(--text-tertiary)]">{episode.scenes.length} scenes</div>
      </div>
      <div className="text-xs text-[var(--text-tertiary)]">~{episode.duration}s</div>
    </motion.div>
  );
}
