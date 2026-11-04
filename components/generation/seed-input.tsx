'use client';

import { useState } from 'react';
import { Lightbulb, X, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';

const EXAMPLE_SEEDS = [
  'A warrior who can hear the thoughts of machines',
  'A small town where everyone has forgotten a tragic event',
  'A child who can see into another dimension',
  'An AI that falls in love with a human artist',
  'A messenger who carries secrets between worlds',
];

interface SeedInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function SeedInput({ value, onChange }: SeedInputProps) {
  const [showExamples, setShowExamples] = useState(false);

  const handleExampleClick = (example: string) => {
    onChange(example);
    setShowExamples(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label htmlFor="seed-input" className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-purple-400" aria-hidden="true" />
          Story Seed (Optional)
        </label>
        <button
          type="button"
          onClick={() => setShowExamples(!showExamples)}
          className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded"
        >
          <Lightbulb className="w-3.5 h-3.5" aria-hidden="true" />
          {showExamples ? 'Hide' : 'Show'} examples
        </button>
      </div>

      <div className="relative">
        <textarea
          id="seed-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Describe your story concept... e.g., 'A lone samurai must protect a village from a demon using only his wits and a broken blade'"
          className="w-full h-24 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-4 text-sm placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
          maxLength={500}
          aria-describedby="seed-hint"
        />
        <div className="absolute bottom-3 right-3 text-xs text-[var(--text-tertiary)]">
          {value.length}/500
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute top-3 right-3 p-1 rounded hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
            aria-label="Clear seed text"
          >
            <X className="w-4 h-4 text-[var(--text-tertiary)]" aria-hidden="true" />
          </button>
        )}
      </div>

      <motion.div
        initial={false}
        animate={{ height: showExamples ? 'auto' : 0, opacity: showExamples ? 1 : 0 }}
        className="overflow-hidden"
        id="seed-hint"
      >
        <div className="pt-3 space-y-2">
          <span className="text-xs text-[var(--text-tertiary)]">Try these ideas:</span>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_SEEDS.map((example, idx) => (
              <button
                type="button"
                key={idx}
                onClick={() => handleExampleClick(example)}
                className="px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-full hover:border-purple-500/50 transition-colors text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}