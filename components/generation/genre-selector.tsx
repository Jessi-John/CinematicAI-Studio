'use client';

import { motion } from 'framer-motion';
import { GENRES } from '@/lib/constants/genres';
import { STORY_COLORS } from '@/lib/constants/genres';
import type { Genre } from '@/types';

interface GenreSelectorProps {
  selectedGenre: Genre | null;
  onSelect: (genre: Genre) => void;
}

export function GenreSelector({ selectedGenre, onSelect }: GenreSelectorProps) {
  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-[var(--text-secondary)]">
        Select Genre
      </label>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
        {GENRES.map((genre) => {
          const isSelected = selectedGenre === genre.value;
          const genreColor = STORY_COLORS[genre.value];

          return (
            <motion.button
              type="button"
              key={genre.value}
              onClick={() => onSelect(genre.value)}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              aria-pressed={isSelected}
              aria-label={`Select ${genre.label} genre`}
              className={`relative p-3 rounded-xl border transition-all focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                isSelected
                  ? 'border-purple-500 bg-purple-500/10'
                  : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-purple-500/50'
              }`}
              style={isSelected ? { borderColor: genreColor } : {}}
            >
              <div className="text-2xl mb-1" aria-hidden="true">{genre.emoji}</div>
              <div className={`text-xs font-medium ${isSelected ? 'text-white' : 'text-[var(--text-secondary)]'}`}>
                {genre.label}
              </div>
              {isSelected && (
                <motion.div
                  layoutId="selectedGenre"
                  className="absolute inset-0 rounded-xl border-2"
                  style={{ borderColor: genreColor }}
                  initial={false}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                />
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}