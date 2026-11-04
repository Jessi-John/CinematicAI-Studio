'use client';

import { useState, useId } from 'react';
import { X, Check, Sparkles, Film, FileText, Scissors, Image, Mic, Search, Users, Globe, Shield, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { Genre, GenerationProgress } from '@/types';
import { GENRES, STORY_COLORS } from '@/lib/constants/genres';
import { GENERATION_STEPS } from '@/lib/utils/generation';

interface GenerationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Close the modal while generation keeps running in the background. */
  onMinimize: () => void;
  onGenerate: (genres: Genre[], seed: string) => void;
  isGenerating: boolean;
  progress: GenerationProgress | null;
}

export function GenerationModal({
  isOpen,
  onClose,
  onMinimize,
  onGenerate,
  isGenerating,
  progress,
}: GenerationModalProps) {
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [seed, setSeed] = useState('');
  const seedInputId = useId();

  const handleGenerate = () => {
    if (selectedGenre !== null) {
      onGenerate(selectedGenre ? [selectedGenre] : [], seed);
    }
  };

  const handleClose = () => {
    if (!isGenerating) {
      setSelectedGenre(null);
      setSeed('');
      onClose();
    }
  };

  const handleMinimize = () => {
    // Minimize = close the modal but keep generating. The useGeneration hook
    // lives in the parent page and continues independently of modal visibility,
    // so onSuccess (toast + redirect) still fires on completion. Do NOT clear
    // the form here — if generation fails, the user can reopen and retry with
    // their genre/seed intact.
    onMinimize();
  };

  const toggleGenre = (genre: Genre) => {
    setSelectedGenre((prev) => (prev === genre ? null : genre));
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" ariaLabel="Create New Story">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg gradient-bg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Create New Story</h2>
            <p className="text-sm text-[var(--text-tertiary)]">
              Generate a cinematic story for YouTube Shorts
            </p>
          </div>
        </div>
        {!isGenerating ? (
          <button
            type="button"
            onClick={handleClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleMinimize}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors text-[var(--text-tertiary)] hover:text-white focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
            title="Minimize to background"
            aria-label="Minimize to background"
          >
            <span className="text-xs" aria-hidden="true">_</span>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-6 overflow-y-auto flex-1">
        {!isGenerating ? (
          <div className="space-y-6">
            {/* Genre Selection */}
            <div role="radiogroup" aria-label="Select genre">
              <label className="text-sm font-medium text-[var(--text-secondary)] mb-3 block">
                Select Genre
              </label>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {GENRES.map((genre) => {
                  const isSelected = selectedGenre === genre.value;
                  const genreColor = STORY_COLORS[genre.value];

                  return (
                    <button
                      key={genre.value}
                      type="button"
                      data-testid={`genre-${genre.value}`}
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => toggleGenre(genre.value)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${
                        isSelected
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-[var(--border)] bg-[var(--bg-tertiary)] hover:border-purple-500/50'
                      }`}
                      style={isSelected ? { borderColor: genreColor } : {}}
                    >
                      <span className="text-2xl" aria-hidden="true">{genre.emoji}</span>
                      <span
                        className={`text-xs font-medium ${
                          isSelected ? 'text-white' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        {genre.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Seed Input */}
            <div>
              <label htmlFor={seedInputId} className="text-sm font-medium text-[var(--text-secondary)] mb-2 block">
                Story Seed (Optional)
              </label>
              <textarea
                id={seedInputId}
                data-testid="seed-input"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="Describe your story concept... e.g., 'A lone warrior guarding a mystical portal'"
                className="w-full h-24 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-xl p-4 text-sm placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500/30 transition-colors"
                maxLength={500}
              />
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-[var(--text-tertiary)]">
                  Optional: Add a specific concept or theme
                </span>
                <span className="text-xs text-[var(--text-tertiary)]">
                  {seed.length}/500
                </span>
              </div>
            </div>
          </div>
        ) : (
          <GenerationProgressView progress={progress} />
        )}
      </div>

      {/* Footer */}
      {!isGenerating && (
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-3">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            data-testid="generate-story-btn"
            onClick={handleGenerate}
            disabled={selectedGenre === null}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Generate Story
          </Button>
        </div>
      )}
    </Modal>
  );
}

interface GenerationProgressViewProps {
  progress: GenerationProgress | null;
}

function GenerationProgressView({ progress }: GenerationProgressViewProps) {
  if (!progress) return null;

  const currentStepIndex = GENERATION_STEPS.findIndex(
    (s) => s.stage === progress.stage
  );

  return (
    <div className="space-y-6">
      {/* Progress Bar */}
      <div>
        <div className="flex justify-between text-sm mb-2">
          <span className="text-[var(--text-secondary)]">
            {progress.message}
          </span>
          <span className="text-purple-400" aria-hidden="true">{Math.round(progress.progress)}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.progress)}
          aria-label="Story generation progress"
          className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden"
        >
          <div
            className="h-full gradient-bg rounded-full transition-all duration-300"
            style={{ width: `${progress.progress}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {GENERATION_STEPS.map((step, idx) => {
          const isActive = idx === currentStepIndex;
          const isComplete = idx < currentStepIndex;
          const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
            sparkles: Sparkles,
            check: Check,
            film: Film,
            'file-text': FileText,
            scissors: Scissors,
            image: Image,
            mic: Mic,
            search: Search,
            users: Users,
            globe: Globe,
            shield: Shield,
            database: Database,
          };
          const Icon = ICON_MAP[step.icon] ?? Film;

          return (
            <div
              key={step.stage}
              aria-current={isActive ? 'step' : undefined}
              className={`flex items-center gap-3 p-3 rounded-lg transition-all ${
                isActive
                  ? 'bg-purple-500/10 border border-purple-500/30'
                  : isComplete
                  ? 'bg-emerald-500/10'
                  : 'bg-[var(--bg-tertiary)]'
              }`}
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  isActive
                    ? 'bg-purple-500 text-white'
                    : isComplete
                    ? 'bg-emerald-500 text-white'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)]'
                }`}
              >
                {isComplete ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Icon className="w-4 h-4" />
                )}
              </div>
              <div className="flex-1">
                <div
                  className={`text-sm font-medium ${
                    isActive
                      ? 'text-white'
                      : isComplete
                      ? 'text-emerald-400'
                      : 'text-[var(--text-tertiary)]'
                  }`}
                >
                  {step.label}
                </div>
                <div className="text-xs text-[var(--text-tertiary)]">
                  {step.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
