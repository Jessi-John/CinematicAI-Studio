/**
 * L4-CREATE-ARCH: Client Component (retained).
 *
 * Evaluation: This page is a form with no static data. Its value is the
 * real-time generation feedback loop (SSE/polling, progress bar, copy-to-
 * clipboard). Server-rendering an empty form does not improve perceived load
 * time in any measurable way.
 */
'use client';

import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, ArrowLeft, Copy, Check, Loader2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/lib/stores/app-store';
import { useGeneration } from '@/hooks/use-generation';
import { GenreSelector } from '@/components/generation/genre-selector';
import { SeedInput } from '@/components/generation/seed-input';
import { GenerationPreview } from '@/components/generation/generation-preview';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/error-boundary';
import type { Genre } from '@/types';


export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const addToast = useAppStore((state) => state.addToast);

  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [seed, setSeed] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const { generate, isGenerating, progress, error, generatedStory, reset } = useGeneration({
    onSuccess: (story) => {
      queryClient.invalidateQueries({ queryKey: ['stories'] });
      addToast('success', 'Story generated successfully!');
      if (story?.id) router.push(`/story/${story.id}`);
    },
    onError: (msg) => {
      addToast('error', msg);
    },
  });

  const handleGenreSelect = (genre: Genre): void => {
    setSelectedGenre((prev) => prev === genre ? null : genre);
  };

  const handleGenerate = (): void => {
    if (selectedGenre === null) {
      addToast('error', 'Please select at least one genre');
      return;
    }
    if (submittingRef.current || isGenerating) return;
    submittingRef.current = true;
    // The generation pipeline stores and builds against one canonical genre.
    // The API envelope expects an array; send a single-element array.
    void generate({ genre: [selectedGenre], seed: seed || undefined }).finally(() => {
      submittingRef.current = false;
    });
  };

  const handleViewStory = (): void => {
    if (generatedStory) router.push(`/story/${generatedStory.id}`);
  };

  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      addToast('error', 'Failed to copy');
    }
  };

  return (
    <ErrorBoundary>
    <div className="min-h-screen pb-20 md:pb-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-white mb-4 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none rounded"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back to Dashboard
          </Link>
          <h1 className="text-3xl font-bold mb-2">Create New Story</h1>
          <p className="text-[var(--text-secondary)]">
            Generate a unique cinematic story for YouTube Shorts
          </p>
        </motion.div>

        {!generatedStory && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-6 mb-6"
          >
      <GenreSelector
        selectedGenre={selectedGenre}
        onSelect={handleGenreSelect}
      />
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-6 mb-6"
        >
          <SeedInput
            value={seed}
            onChange={setSeed}
          />
        </motion.div>

        {!isGenerating && !generatedStory && !error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex justify-center mb-8"
          >
            <Button
              size="lg"
              onClick={handleGenerate}
              disabled={isGenerating || selectedGenre === null}
              className="px-8 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
              aria-label="Generate Story"
            >
              <Sparkles className="w-5 h-5 mr-2" aria-hidden="true" />
              Generate Story
            </Button>
          </motion.div>
        )}

        {isGenerating && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl p-6 mb-6"
          >
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
              <div>
                <h3 className="font-semibold">Generating Story</h3>
                <p className="text-sm text-[var(--text-tertiary)]">
                  {progress?.message || 'Starting generation...'}
                </p>
              </div>
            </div>
            {progress && (
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-[var(--text-secondary)]">
                    {progress.stage}
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
                  <motion.div
                    className="h-full bg-gradient-to-r from-purple-500 to-purple-400 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress.progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>
            )}
          </motion.div>
        )}

        {error && !isGenerating && !generatedStory && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-500/10 border border-red-500/30 rounded-2xl p-6 mb-6"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-red-400 mb-1">Generation Failed</h3>
                <p className="text-sm text-[var(--text-secondary)] break-words">{error}</p>
              </div>
            </div>
            <div className="mt-4 flex gap-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  reset();
                }}
              >
                Try Again
              </Button>
            </div>
          </motion.div>
        )}

        {generatedStory && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <GenerationPreview story={generatedStory} onViewStory={handleViewStory} />

            <div className="mt-6 p-6 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-2xl">
              <h3 className="text-lg font-semibold mb-4">Story Details</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-[var(--text-tertiary)]">Story ID</span>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 bg-[var(--bg-tertiary)] px-2 py-1 rounded text-xs font-mono truncate">
                      {generatedStory.id}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyId(generatedStory.id)}
                      className="p-1.5 rounded hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
                      aria-label="Copy story ID"
                    >
                      {copiedId === generatedStory.id ? (
                        <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                      ) : (
                        <Copy className="w-4 h-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)]">Created</span>
                  <p className="mt-1">
                    {new Date(generatedStory.createdAt).toLocaleString()}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)]">Genre</span>
                  <p className="mt-1 capitalize">{generatedStory.genre}</p>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)]">Total Episodes</span>
                  <p className="mt-1">{generatedStory.episodes.length}</p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-center gap-4">
              <Button
                variant="secondary"
                onClick={() => {
                  reset();
                  setSelectedGenre(null);
                  setSeed('');
                }}
              >
                Create Another
              </Button>
              <Button onClick={handleViewStory}>View Full Story</Button>
            </div>
          </motion.div>
        )}
      </div>
    </div>
    </ErrorBoundary>
  );
}
