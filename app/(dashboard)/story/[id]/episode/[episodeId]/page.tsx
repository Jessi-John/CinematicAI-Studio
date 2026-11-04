'use client';

import { useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, Download, Camera, Film, Play, Clock } from 'lucide-react';
import Link from 'next/link';
import { useAppStore } from '@/lib/stores/app-store';
import { useStory } from '@/lib/query/stories';
import { useRegenerateScene } from '@/lib/query/analytics';
import { slugify } from '@/lib/utils/slugify';
import { SceneRow } from '@/components/story/scene-row';
import { Button } from '@/components/ui/button';

export default function EpisodePage() {
  const params = useParams();
  const router = useRouter();
  const addToast = useAppStore((state) => state.addToast);

  const storyId = String(params.id);
  const episodeId = String(params.episodeId);

  const { data: story, isLoading } = useStory(storyId);
  const episode = story?.episodes.find((e) => e.id === episodeId);
  const storyTitle = story?.title || '';
  const regenScene = useRegenerateScene(storyId);

  const redirectedRef = useRef(false);

  useEffect(() => {
    if (redirectedRef.current || isLoading) return;
    if (story && !episode) {
      redirectedRef.current = true;
      router.replace(`/story/${storyId}`);
    } else if (!isLoading && !story) {
      redirectedRef.current = true;
      router.replace('/');
    }
  }, [isLoading, story, episode, storyId, router]);

  const handleCopy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('success', 'Copied to clipboard');
    } catch {
      addToast('error', 'Failed to copy');
    }
  };

  const downloadText = (filename: string, content: string, mimeType = 'text/plain'): void => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addToast('success', 'Episode exported');
  };

  if (!episode) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 md:pb-8">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <Link
            href={`/story/${storyId}`}
            className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-white mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {storyTitle}
          </Link>

          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center">
              <span className="text-3xl font-bold text-purple-400">{episode.number}</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">{episode.title}</h1>
              <p className="text-[var(--text-secondary)]">
                {episode.scenes.length} scenes - ~{episode.duration}s
              </p>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-2 gap-4 mb-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
          >
            <h3 className="text-sm font-medium text-[var(--text-tertiary)] mb-2 flex items-center gap-2">
              <Play className="w-4 h-4" />
              Opening Hook
            </h3>
            <p className="text-white">{episode.hook}</p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
          >
            <h3 className="text-sm font-medium text-[var(--text-tertiary)] mb-2 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Cliffhanger
            </h3>
            <p className="text-white">{episode.cliffhanger}</p>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-8"
        >
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Film className="w-5 h-5 text-purple-400" />
            Synopsis
          </h2>
          <p className="text-[var(--text-secondary)] p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            {episode.synopsis}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mb-6"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Camera className="w-5 h-5 text-purple-400" />
              Scenes
            </h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const allPrompts = episode.scenes
                  .map(
                    (scene, idx) =>
                      `Scene ${idx + 1}:\nImage: ${scene.imagePrompt.content}\nVideo: ${scene.videoPrompt.content}\nNarration: ${scene.narration.text}`
                  )
                  .join('\n\n');
                void handleCopy(allPrompts);
              }}
              aria-label="Copy all prompts"
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy All Prompts
            </Button>
          </div>

          <div className="space-y-4">
            {episode.scenes.map((scene, idx) => (
              <SceneRow
                key={scene.id}
                scene={scene}
                index={idx}
                onCopyImagePrompt={() => void handleCopy(scene.imagePrompt.content)}
                onCopyVideoPrompt={() => void handleCopy(scene.videoPrompt.content)}
                onCopyNarration={() => void handleCopy(scene.narration.text)}
                onRegenerate={() => {
                  regenScene.mutate(
                    { episodeNumber: episode.number, sceneNumber: scene.number },
                    {
                      onSuccess: () =>
                        addToast(
                          'success',
                          `Scene ${episode.number}.${scene.number} regenerated`
                        ),
                      onError: (err) =>
                        addToast(
                          'error',
                          err instanceof Error ? err.message : 'Failed to regenerate scene'
                        ),
                    }
                  );
                }}
                isRegenerating={
                  regenScene.isPending &&
                  regenScene.variables?.episodeNumber === episode.number &&
                  regenScene.variables?.sceneNumber === scene.number
                }
              />
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="p-6 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl"
        >
          <h3 className="text-lg font-semibold mb-4">Quick Export</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() =>
                downloadText(
                  `${slugify(episode.title)}.json`,
                  JSON.stringify(episode, null, 2),
                  'application/json'
                )
              }
            >
              <Download className="w-4 h-4 mr-2" />
              JSON
            </Button>
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() =>
                downloadText(
                  `${slugify(episode.title)}-image-prompts.txt`,
                  episode.scenes
                    .map((scene) => `Scene ${scene.number}\n${scene.imagePrompt.content}`)
                    .join('\n\n')
                )
              }
            >
              <Download className="w-4 h-4 mr-2" />
              Image Prompts
            </Button>
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() =>
                downloadText(
                  `${slugify(episode.title)}-video-prompts.txt`,
                  episode.scenes
                    .map((scene) => `Scene ${scene.number}\n${scene.videoPrompt.content}`)
                    .join('\n\n')
                )
              }
            >
              <Download className="w-4 h-4 mr-2" />
              Video Prompts
            </Button>
            <Button
              variant="secondary"
              className="justify-start"
              onClick={() =>
                downloadText(
                  `${slugify(episode.title)}-narration.txt`,
                  episode.scenes.map((scene) => scene.narration.text).join('\n\n')
                )
              }
            >
              <Download className="w-4 h-4 mr-2" />
              Narration
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
