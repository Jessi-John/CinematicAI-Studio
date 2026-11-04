'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowLeft, Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GENRE_MAP, STORY_COLORS } from '@/lib/constants/genres';
import type { Story } from '@/types';

interface StoryHeaderProps {
  story: Story;
  isRegenerating: boolean;
  isDeleting: boolean;
  onExport: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

export function StoryHeader({ story, isRegenerating, isDeleting, onExport, onRegenerate, onDelete }: StoryHeaderProps) {
  const genreColor = STORY_COLORS[story.genre] ?? STORY_COLORS.fantasy;
  const genre = GENRE_MAP[story.genre] ?? null;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>
      <div className="flex items-start justify-between">
        <div>
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium mb-3"
            style={{ backgroundColor: `${genreColor}33`, color: genreColor }}
          >
            {genre?.emoji} {genre?.label}
          </span>
          <h1 className="text-3xl font-bold mb-2">{story.title}</h1>
          <p className="text-[var(--text-secondary)]">
            {/* Explicit locale + UTC so SSR and client hydration format the
                date identically (avoids hydration mismatch from host tz/locale). */}
            Created {new Date(story.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' })} - {story.episodes.length} episodes
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onExport} disabled={isRegenerating || isDeleting} aria-label="Export story">
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button variant="secondary" onClick={onRegenerate} disabled={isRegenerating || isDeleting} aria-label="Regenerate story">
            {isRegenerating ? (
              <>
                <div className="w-4 h-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Regenerating...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Regenerate
              </>
            )}
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={isRegenerating || isDeleting} aria-label="Delete story">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
