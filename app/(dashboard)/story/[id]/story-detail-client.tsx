'use client';

import { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { AlertCircle, Copy } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/lib/stores/app-store';
import { useStory, useDeleteStory, useRegenerateStory } from '@/lib/query/stories';
import { useRegenerateEpisode } from '@/lib/query/analytics';
import { apiRawFetch } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ErrorBoundary } from '@/components/error-boundary';
import { StoryHeader } from '@/components/story/story-header';
import { StoryOverviewTab } from '@/components/story/story-overview-tab';
import { StoryPromptsTab } from '@/components/story/story-prompts-tab';
import { StorySeoTab } from '@/components/story/story-seo-tab';
import { InlineEditor } from '@/components/story/inline-editor';
import type { Story } from '@/types';

type StoryTab = 'overview' | 'image-prompts' | 'video-prompts' | 'seo';

export default function StoryDetailClient({ initialStory }: { initialStory?: Story | undefined } = {}) {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);

  const storyId = String(params.id);
  const { data: story, isLoading, isError } = useStory(storyId, initialStory);
  const deleteMutation = useDeleteStory();
  const regenStory = useRegenerateStory();
  const regenEpisode = useRegenerateEpisode(storyId);

  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [activeTab, setActiveTab] = useState<StoryTab>('overview');
  const [regeneratingEpisodes, setRegeneratingEpisodes] = useState<Set<number>>(new Set());

  const allImagePrompts = useMemo(() =>
    story ? story.episodes.flatMap((ep) =>
      ep.scenes.map((sc) => ({ episode: ep.number, scene: sc.number, content: sc.imagePrompt.content }))
    ) : [], [story]);
  const allVideoPrompts = useMemo(() =>
    story ? story.episodes.flatMap((ep) =>
      ep.scenes.map((sc) => ({ episode: ep.number, scene: sc.number, content: sc.videoPrompt.content }))
    ) : [], [story]);

  const handleCopy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('success', 'Copied to clipboard');
    } catch {
      addToast('error', 'Failed to copy');
    }
  };

  const handleDelete = (): void => {
    if (!story) return;
    deleteMutation.mutate(story.id, {
      onSuccess: () => {
        addToast('success', 'Story deleted');
        setShowDeleteModal(false);
        router.push('/');
      },
      onError: (err) => {
        addToast('error', err instanceof Error ? err.message : 'Failed to delete story');
      },
    });
  };

  const handleRegenerate = (): void => {
    if (!story) return;
    regenStory.mutate(story.id, {
      onSuccess: (data) => {
        addToast('success', 'Story regenerated atomically');
        router.push(`/story/${data.storyId}`);
      },
      onError: (err) => {
        addToast('error', err instanceof Error ? err.message : 'Failed to regenerate story');
      },
    });
  };

  const handleRegenerateEpisode = (episodeNumber: number): void => {
    setRegeneratingEpisodes((prev) => new Set([...prev, episodeNumber]));
    regenEpisode.mutate(episodeNumber, {
      onSuccess: () => {
        addToast('success', `Episode ${episodeNumber} regenerated`);
        setRegeneratingEpisodes((prev) => {
          const next = new Set(prev);
          next.delete(episodeNumber);
          return next;
        });
      },
      onError: (err) => {
        addToast('error', err instanceof Error ? err.message : 'Failed to regenerate episode');
        setRegeneratingEpisodes((prev) => {
          const next = new Set(prev);
          next.delete(episodeNumber);
          return next;
        });
      },
    });
  };

  const handleExportRemote = async (format: 'json' | 'csv' | 'txt' | 'ssml' | 'srt' | 'vtt'): Promise<void> => {
    if (!story) return;
    try {
      const subtitleFormats = new Set(['ssml', 'srt', 'vtt']);
      const content = subtitleFormats.has(format) ? 'voiceover-only' : 'full';
      const r = await apiRawFetch(`${API_BASE}/api/stories/${story.id}/export`, {
        method: 'POST', isMutation: true,
        body: JSON.stringify({ format, content }),
      });
      if (!r.ok) throw new Error(`Export failed: ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = story.title.replace(/[^a-z0-9]/gi, '_') || 'story';
      const extMap: Record<string, string> = { json: 'json', csv: 'csv', txt: 'txt', ssml: 'ssml.xml', srt: 'srt', vtt: 'vtt' };
      a.download = `${safeName}.${extMap[format] || format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast('success', `Exported as ${format.toUpperCase()}`);
      setShowExportModal(false);
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Export failed');
    }
  };

  if (isError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="max-w-md w-full mx-4 text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h1 className="text-xl font-bold mb-2">Failed to load story</h1>
          <p className="text-[var(--text-secondary)] mb-6">An error occurred while fetching this story.</p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="secondary" onClick={() => router.push('/')}>
              Back to Dashboard
            </Button>
            <Button onClick={() => queryClient.invalidateQueries({ queryKey: ['story', storyId] })}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !story) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const selectedEpisode = selectedEpisodeId !== null
    ? story.episodes.find((ep) => ep.id === selectedEpisodeId) ?? null
    : null;

  const hasSeo = Boolean(story.youtubeSeo);
  const tabs: { id: StoryTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'image-prompts', label: `Image Prompts (${story.episodes.reduce((sum, ep) => sum + ep.scenes.length, 0)})` },
    { id: 'video-prompts', label: `Video Prompts (${story.episodes.reduce((sum, ep) => sum + ep.scenes.length, 0)})` },
  ];
  if (hasSeo) tabs.push({ id: 'seo', label: 'YouTube SEO' });

  return (
    <ErrorBoundary>
      <div className="min-h-screen pb-20 md:pb-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <StoryHeader
            story={story}
            isRegenerating={regenStory.isPending}
            isDeleting={deleteMutation.isPending}
            onExport={() => setShowExportModal(true)}
            onRegenerate={handleRegenerate}
            onDelete={() => setShowDeleteModal(true)}
          />

          <div
            role="tablist"
            aria-label="Story sections"
            className="flex gap-1 mt-4 border-b border-[var(--border)]"
            onKeyDown={(e) => {
              const idx = tabs.findIndex((t) => t.id === activeTab);
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                setActiveTab(tabs[(idx + 1) % tabs.length]!.id);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]!.id);
              } else if (e.key === 'Home') {
                e.preventDefault();
                setActiveTab(tabs[0]!.id);
              } else if (e.key === 'End') {
                e.preventDefault();
                setActiveTab(tabs[tabs.length - 1]!.id);
              }
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`story-tab-${tab.id}`}
                role="tab"
                type="button"
                aria-selected={activeTab === tab.id}
                aria-controls={`story-tabpanel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors relative focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none ${activeTab === tab.id ? 'text-purple-400' : 'text-[var(--text-tertiary)] hover:text-white'}`}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <motion.div layoutId="storyTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />
                )}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div role="tabpanel" id="story-tabpanel-overview" aria-labelledby="story-tab-overview">
              <StoryOverviewTab
                story={story}
                onEpisodeClick={(idx) => setSelectedEpisodeId(story.episodes[idx]?.id ?? null)}
                onRegenerateEpisode={handleRegenerateEpisode}
                regeneratingEpisodes={regeneratingEpisodes}
              />
            </div>
          )}

          {activeTab === 'image-prompts' && (
            <div role="tabpanel" id="story-tabpanel-image-prompts" aria-labelledby="story-tab-image-prompts">
              <StoryPromptsTab title="Image Prompts" icon="🖼️" prompts={allImagePrompts} episodeCount={story.episodes.length} onCopy={handleCopy} />
            </div>
          )}

          {activeTab === 'video-prompts' && (
            <div role="tabpanel" id="story-tabpanel-video-prompts" aria-labelledby="story-tab-video-prompts">
              <StoryPromptsTab title="Video Prompts" icon="🎬" prompts={allVideoPrompts} episodeCount={story.episodes.length} onCopy={handleCopy} />
            </div>
          )}

          {activeTab === 'seo' && story.youtubeSeo && (
            <div role="tabpanel" id="story-tabpanel-seo" aria-labelledby="story-tab-seo">
              <StorySeoTab seo={story.youtubeSeo} />
            </div>
          )}
        </div>

        <Modal isOpen={selectedEpisodeId !== null} onClose={() => setSelectedEpisodeId(null)} title={`Episode ${selectedEpisode?.number}: ${selectedEpisode?.title}`} size="xl">
          {selectedEpisode && (
            <div className="space-y-6">{/* Full episode content */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
                  <p className="text-sm text-[var(--text-tertiary)] mb-2">Hook</p>
                  <p className="text-white">{selectedEpisode.hook}</p>
                </div>
                <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
                  <p className="text-sm text-[var(--text-tertiary)] mb-2">Cliffhanger</p>
                  <p className="text-white">{selectedEpisode.cliffhanger}</p>
                </div>
              </div>
              <h4 className="text-sm font-medium text-[var(--text-secondary)]">Scenes ({selectedEpisode.scenes.length})</h4>
              <div className="space-y-4 max-h-[400px] overflow-y-auto">
                {selectedEpisode.scenes.map((scene) => {
                  return (
                    <div key={scene.id} className="p-4 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border)]">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs font-medium">Scene {scene.number}</span>
                        <span className="text-xs text-[var(--text-tertiary)]">{scene.duration}s</span>
                        <span className="text-xs text-[var(--text-tertiary)]">Intensity: {scene.emotionalIntensity}/10</span>
                      </div>
                      <div className="mb-4 p-3 bg-gradient-to-r from-pink-500/10 to-purple-500/10 rounded-lg border border-pink-500/20">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-medium text-pink-400 uppercase tracking-wider">Voiceover</span>
                          <span className="text-xs text-[var(--text-tertiary)]">• {scene.narration.emotion}</span>
                        </div>
                        <InlineEditor storyId={story.id} episodeNumber={selectedEpisode.number} sceneNumber={scene.number} field="narrationText" value={scene.narration.text} version={scene.version ?? 0} label="Scene narration" onSave={() => queryClient.invalidateQueries({ queryKey: ['story', storyId] })} />
                        <div className="mt-2 flex items-center gap-4 text-xs text-[var(--text-tertiary)]">
                          <span>Duration: {scene.narration.timing?.totalDuration || 15}s</span>
                          <span>{scene.narration.timing?.wordsPerMinute || 150} WPM</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-[var(--bg-secondary)] rounded border border-[var(--border)]">
                          <div className="flex items-center gap-2 mb-2">
                            <p className="text-xs font-medium text-[var(--text-tertiary)] uppercase">Image Prompt</p>
                            <button type="button" onClick={() => void handleCopy(scene.imagePrompt.content)} className="ml-auto p-1 rounded hover:bg-white/10" aria-label="Copy image prompt">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <p className="text-xs text-[var(--text-secondary)] font-mono line-clamp-3">{scene.imagePrompt.content}</p>
                        </div>
                        <div className="p-3 bg-[var(--bg-secondary)] rounded border border-[var(--border)]">
                          <div className="flex items-center gap-2 mb-2">
                            <p className="text-xs font-medium text-[var(--text-tertiary)] uppercase">Video Prompt</p>
                            <button type="button" onClick={() => void handleCopy(scene.videoPrompt.content)} className="ml-auto p-1 rounded hover:bg-white/10" aria-label="Copy video prompt">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <p className="text-xs text-[var(--text-secondary)] font-mono line-clamp-3">{scene.videoPrompt.content}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Modal>

        <Modal isOpen={showExportModal} onClose={() => setShowExportModal(false)} title="Export Story" size="sm">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">Download your story in the desired format</p>
            <div className="grid grid-cols-1 gap-3">
              <Button variant="secondary" onClick={() => void handleExportRemote('json')}>Export as JSON (Full Story)</Button>
              <Button variant="secondary" onClick={() => void handleExportRemote('csv')}>Export as CSV (Scenes)</Button>
              <Button variant="secondary" onClick={() => void handleExportRemote('txt')}>Export as TXT (Full Story)</Button>
              <Button variant="secondary" onClick={() => void handleExportRemote('ssml')}>Export TTS Script (SSML)</Button>
              <Button variant="secondary" onClick={() => void handleExportRemote('srt')}>Export Subtitles (SRT)</Button>
              <Button variant="secondary" onClick={() => void handleExportRemote('vtt')}>Export Subtitles (WebVTT)</Button>
            </div>
          </div>
        </Modal>

        <Modal isOpen={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete Story" size="sm">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">Are you sure you want to delete this story? This action cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowDeleteModal(false)} disabled={deleteMutation.isPending}>Cancel</Button>
              <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? (
                  <><div className="w-4 h-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />Deleting...</>
                ) : 'Delete'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </ErrorBoundary>
  );
}
