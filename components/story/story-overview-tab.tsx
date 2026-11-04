'use client';

import { motion } from 'framer-motion';
import { TrendingUp, Film, Mic } from 'lucide-react';
import { EpisodeCard } from '@/components/story/episode-card';
import type { Story } from '@/types';

interface StoryOverviewTabProps {
  story: Story;
  onEpisodeClick: (index: number) => void;
  onRegenerateEpisode: (episodeNumber: number) => void;
  regeneratingEpisodes: Set<number>;
}

export function StoryOverviewTab({ story, onEpisodeClick, onRegenerateEpisode, regeneratingEpisodes }: StoryOverviewTabProps) {
  return (
    <>
      {story.metadata && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-3 gap-4 mb-8"
        >
          <div className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            <div className="flex items-center gap-2 text-[var(--text-tertiary)] mb-1">
              <TrendingUp className="w-4 h-4" />
              Virality Score
            </div>
            <div className="text-2xl font-bold text-purple-400">{story.metadata.viralityScore ?? 0}%</div>
          </div>
          <div className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            <div className="flex items-center gap-2 text-[var(--text-tertiary)] mb-1">
              <TrendingUp className="w-4 h-4" />
              Monetization
            </div>
            <div className="text-2xl font-bold text-emerald-400">{story.metadata.monetizationScore ?? 0}%</div>
          </div>
          <div className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            <div className="flex items-center gap-2 text-[var(--text-tertiary)] mb-1">
              <Film className="w-4 h-4" />
              Total Scenes
            </div>
            <div className="text-2xl font-bold">{story.metadata.totalScenes}</div>
          </div>
        </motion.div>
      )}

      {(story.qualityScore ?? story.metadata?.qualityScore) && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="mb-8"
        >
          <div className="inline-flex items-center gap-3 px-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-tertiary)]">Quality</span>
              <span className="text-lg font-bold text-purple-400">
                {story.qualityScore ?? story.metadata?.qualityScore}/100
              </span>
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                (story.qualityGrade ?? story.metadata?.qualityGrade) === 'A' ? 'text-green-500 bg-green-500/10' :
                (story.qualityGrade ?? story.metadata?.qualityGrade) === 'B' ? 'text-blue-500 bg-blue-500/10' :
                (story.qualityGrade ?? story.metadata?.qualityGrade) === 'C' ? 'text-amber-500 bg-amber-500/10' :
                (story.qualityGrade ?? story.metadata?.qualityGrade) === 'D' ? 'text-orange-500 bg-orange-500/10' :
                'text-red-500 bg-red-500/10'
              }`}>
                {story.qualityGrade ?? story.metadata?.qualityGrade}
              </span>
            </div>
          </div>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mb-8"
      >
        <details className="group bg-gradient-to-r from-pink-500/10 via-purple-500/10 to-pink-500/10 rounded-xl border border-pink-500/20 p-6">
          <summary className="cursor-pointer flex items-center gap-2">
            <Mic className="w-5 h-5 text-pink-400" />
            <h2 className="text-lg font-semibold">Full story narration</h2>
            <span className="ml-auto text-xs text-[var(--text-tertiary)] group-open:hidden">
              Click to expand
            </span>
          </summary>
          <div className="mt-4 space-y-6">
            {story.episodes.map((episode) => (
              <div key={episode.id}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="px-3 py-1 bg-purple-500/20 text-purple-400 rounded-full text-sm font-medium">
                    Episode {episode.number}
                  </span>
                  <span className="text-sm text-pink-400 italic">{episode.hook}</span>
                </div>
                <div className="space-y-2 pl-2 border-l-2 border-purple-500/30">
                  {episode.scenes.map((scene) => (
                    <p key={scene.id} className="text-sm text-[var(--text-secondary)] leading-relaxed pl-4">
                      {scene.narration.text}
                    </p>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-purple-500/10">
                  <p className="text-xs text-orange-400 italic">
                    Cliffhanger: {episode.cliffhanger}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </details>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <motion.h2
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-lg font-semibold"
          >
            Episodes
          </motion.h2>

          {story.episodes.map((episode, idx) => (
            <EpisodeCard
              key={episode.id}
              episode={episode}
              index={idx}
              storyTitle={story.title}
              onClick={() => onEpisodeClick(idx)}
              onRegenerate={() => onRegenerateEpisode(episode.number)}
              isRegenerating={regeneratingEpisodes.has(episode.number)}
            />
          ))}
        </div>

        <div className="space-y-4">
          <motion.h2
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-lg font-semibold"
          >
            Characters
          </motion.h2>

          <div className="space-y-2">
            {story.characters.map((char) => (
              <div key={char.id} className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{char.name}</h3>
                  <span className="text-xs text-purple-400 capitalize">{char.role}</span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">{char.description}</p>
              </div>
            ))}
          </div>

          <motion.h2
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-lg font-semibold mt-6"
          >
            Environments
          </motion.h2>

          <div className="space-y-2">
            {story.environments.map((env) => (
              <div key={env.id} className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{env.name}</h3>
                  <span className="text-xs text-[var(--text-tertiary)]">{env.timeOfDay}</span>
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded">{env.weather}</span>
                  <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded">{env.mood}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
