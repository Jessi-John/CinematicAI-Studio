'use client';

import { motion } from 'framer-motion';
import { Copy, RefreshCw, Camera, Clapperboard, MessageSquare } from 'lucide-react';
import type { Scene } from '@/types';

interface SceneRowProps {
  scene: Scene;
  index: number;
  onCopyImagePrompt?: () => void;
  onCopyVideoPrompt?: () => void;
  onCopyNarration?: () => void;
  onRegenerate?: () => void;
  isRegenerating?: boolean;
}

export function SceneRow({
  scene,
  index,
  onCopyImagePrompt,
  onCopyVideoPrompt,
  onCopyNarration,
  onRegenerate,
  isRegenerating,
}: SceneRowProps) {
  const narrationText =
    typeof scene.narration === 'string' ? scene.narration : scene.narration?.text || '';
  const imagePromptText =
    typeof scene.imagePrompt === 'string' ? scene.imagePrompt : scene.imagePrompt?.content || '';
  const videoPromptText =
    typeof scene.videoPrompt === 'string' ? scene.videoPrompt : scene.videoPrompt?.content || '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02 }}
      className="group p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] hover:border-purple-500/30 transition-all"
    >
      <div className="flex items-start gap-4">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">SCENE</span>
          <span className="text-lg font-bold text-purple-400">{scene.number}</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div
              className="px-2 py-0.5 rounded text-xs"
              style={{
                backgroundColor:
                  scene.emotionalIntensity > 7 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(124, 58, 237, 0.2)',
                color: scene.emotionalIntensity > 7 ? '#EF4444' : '#A855F7',
              }}
            >
              Intensity: {scene.emotionalIntensity}/10
            </div>
            <div className="px-2 py-0.5 rounded text-xs bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
              {scene.transitionType}
            </div>
            <div className="px-2 py-0.5 rounded text-xs bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
              {scene.duration}s
            </div>
            <div className="px-2 py-0.5 rounded text-xs bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
              {scene.narration.emotion}
            </div>
          </div>

          <p className="text-sm text-[var(--text-secondary)] mb-3 line-clamp-2">{narrationText}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="p-3 bg-[var(--bg-tertiary)] rounded border border-[var(--border)] group/prompt">
              <div className="flex items-center gap-2 mb-2">
                <Camera className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-medium text-[var(--text-tertiary)] uppercase">
                  Image Prompt
                </span>
                <button
                  type="button"
                  onClick={onCopyImagePrompt}
                  className="ml-auto p-1.5 rounded hover:bg-white/10 transition-colors opacity-0 group-hover/prompt:opacity-100 focus-visible:opacity-100"
                  title="Copy image prompt"
                  aria-label="Copy image prompt"
                >
                  <Copy className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                </button>
              </div>
              <p className="text-xs text-[var(--text-secondary)] font-mono line-clamp-3">
                {imagePromptText}
              </p>
            </div>

            <div className="p-3 bg-[var(--bg-tertiary)] rounded border border-[var(--border)] group/prompt">
              <div className="flex items-center gap-2 mb-2">
                <Clapperboard className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-medium text-[var(--text-tertiary)] uppercase">
                  Video Prompt
                </span>
                <button
                  type="button"
                  onClick={onCopyVideoPrompt}
                  className="ml-auto p-1.5 rounded hover:bg-white/10 transition-colors opacity-0 group-hover/prompt:opacity-100 focus-visible:opacity-100"
                  title="Copy video prompt"
                  aria-label="Copy video prompt"
                >
                  <Copy className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                </button>
              </div>
              <p className="text-xs text-[var(--text-secondary)] font-mono line-clamp-3">
                {videoPromptText}
              </p>
            </div>
          </div>

          <div className="mt-3 p-3 bg-[var(--bg-tertiary)] rounded border border-[var(--border)] group/prompt">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-purple-400" />
              <span className="text-xs font-medium text-[var(--text-tertiary)] uppercase">
                Narration
              </span>
              <button
                type="button"
                onClick={onCopyNarration}
                className="ml-auto p-1.5 rounded hover:bg-white/10 transition-colors opacity-0 group-hover/prompt:opacity-100 focus-visible:opacity-100"
                title="Copy narration"
                aria-label="Copy narration"
              >
                <Copy className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
              </button>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">{narrationText}</p>
          </div>
        </div>

        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={isRegenerating}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-[var(--text-tertiary)] hover:text-purple-300 disabled:opacity-50"
            title="Regenerate scene"
            aria-label={`Regenerate scene ${scene.number}`}
          >
            <RefreshCw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center gap-4 text-xs text-[var(--text-tertiary)] flex-wrap">
        <span>Camera: {scene.cameraDirection?.type || 'static'}</span>
        <span>Char: {scene.characterState?.action || 'standing'}</span>
        <span>Env: {scene.environmentState?.atmosphere || 'calm'}</span>
      </div>
    </motion.div>
  );
}
