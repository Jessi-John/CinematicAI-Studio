/**
 * H7 regression: checkpoint keys (candidate + stage:*:done flags) must be
 * namespaced with the BullMQ attempt number so a retry never reads
 * checkpoints written by an orphaned previous attempt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Story } from '../../../services/types.js';

const redisStore = new Map<string, string>();

vi.mock('../../../lib/shared-redis.js', () => ({
  getSharedRedis: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
    del: async (...keys: string[]) => { for (const k of keys) redisStore.delete(k); return keys.length; },
    on: () => {},
    ping: async () => 'PONG',
  }),
}));

const mocks = vi.hoisted(() => ({
  noopStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./stages/stage1-uniqueness.js', () => ({ stage1Uniqueness: mocks.noopStage }));
vi.mock('./stages/stage2-blueprint.js', () => ({ stage2Blueprint: mocks.noopStage }));
vi.mock('./stages/stage3-character-bible.js', () => ({ stage3CharacterBible: mocks.noopStage }));
vi.mock('./stages/stage4-world-bible.js', () => ({ stage4WorldBible: mocks.noopStage }));
vi.mock('./stages/stage5-episodes.js', () => ({
  stage5Episodes: vi.fn().mockImplementation(async (ctx: { story?: unknown }) => {
    ctx.story = ctx.story ?? {};
  }),
}));
vi.mock('./stages/stage7-humanization.js', () => ({ stage7Humanization: mocks.noopStage }));
vi.mock('./stages/stage8-quality.js', () => ({
  stage8Quality: vi.fn().mockImplementation(async (ctx: { qualityScore?: number; qualityGrade?: string; story?: { metadata?: Record<string, unknown> } }) => {
    ctx.qualityScore = 90;
    ctx.qualityGrade = 'A';
    if (ctx.story?.metadata) ctx.story.metadata.qualityScore = 90;
  }),
}));
vi.mock('./stages/stage9-seo.js', () => ({ stage9Seo: mocks.noopStage }));
vi.mock('./stages/stage10-copyright-sweep.js', () => ({ stage10CopyrightSweep: mocks.noopStage }));
vi.mock('./stages/stage11-embedding.js', () => ({ stage11Embedding: mocks.noopStage }));

vi.mock('../../../lib/timing.js', () => ({
  episodesPerStory: 2,
  scenesPerEpisode: 2,
  targetWordsPerScene: 30,
  targetEpisodeWordsMin: 121,
  targetEpisodeWordsMax: 145,
  sceneDurationMinSeconds: 10,
  sceneDurationMaxSeconds: 12,
  speakingWpm: 150,
  targetEpisodeSeconds: 55,
}));

import { runGenerationCore } from './orchestrator.js';

function makePreloadedStory(): Story {
  return {
    id: 'orig-1',
    title: 'The Test Story',
    genre: 'fantasy',
    seed: 'a cartographer in a sky-city',
    theme: 'curiosity',
    status: 'complete',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    characters: [
      { id: 'p1', name: 'Arlo', description: 'protagonist', appearance: '', personality: '', role: 'protagonist', gender: 'neutral' },
      { id: 'a1', name: 'Theron', description: 'antagonist', appearance: '', personality: '', role: 'antagonist', gender: 'male' },
      { id: 's1', name: 'Lirael', description: 'supporting', appearance: '', personality: '', role: 'supporting', gender: 'female' },
    ],
    environments: [
      {
        id: 'e1', name: 'Aeolian Spires', description: 'floating city',
        type: 'city', timeOfDay: 'day', weather: 'clear', mood: 'mysterious',
        keyFeatures: ['wind towers'], colorPalette: ['blue'],
        lighting: { primary: 'natural', ambient: 'soft', colorTemperature: '5500K', shadows: 'soft' },
      },
    ],
    episodes: [],
    metadata: {
      totalEpisodes: 0, totalScenes: 0, estimatedDuration: 0,
      targetAudience: 'general', monetizationScore: 80,
      viralityScore: 80, retentionScore: 80, hookStrength: 80,
    },
  } as unknown as Story;
}

describe('H7 — attempt-fenced pipeline checkpoints', () => {
  beforeEach(() => {
    redisStore.clear();
    vi.clearAllMocks();
  });

  it('attempt 2 writes checkpoints under :attempt:2: keys, never the shared keys', async () => {
    await runGenerationCore({
      primaryGenre: 'fantasy',
      seed: 'a cartographer in a sky-city',
      jobId: 'job-fencing',
      requestId: 'req-fencing',
      progressEmit: async () => undefined,
      qualityFloor: 70,
      gradeFloor: 'C',
      aiScoreLimit: 80,
      storyBudget: 50,
      persistMode: 'return-candidate',
      preloadedStory: makePreloadedStory(),
      attempt: 2,
    });

    const keys = [...redisStore.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).toContain(':attempt:2:');
    }
    expect(keys.some((k) => k.includes('candidate:v1'))).toBe(true);
    expect(keys.some((k) => k.includes('stage:blueprint:done'))).toBe(true);
    // The unfenced legacy keys must NOT have been touched.
    expect(redisStore.has('job:job-fencing:candidate:v1')).toBe(false);
    expect(redisStore.has('job:job-fencing:stage:blueprint:done')).toBe(false);
  });

  it('attempt 0/undefined keeps the legacy unfenced keys', async () => {
    await runGenerationCore({
      primaryGenre: 'fantasy',
      seed: 'a cartographer in a sky-city',
      jobId: 'job-fencing',
      requestId: 'req-fencing',
      progressEmit: async () => undefined,
      qualityFloor: 70,
      gradeFloor: 'C',
      aiScoreLimit: 80,
      storyBudget: 50,
      persistMode: 'return-candidate',
      preloadedStory: makePreloadedStory(),
    });

    const keys = [...redisStore.keys()];
    expect(keys.some((k) => k === 'job:job-fencing:candidate:v1')).toBe(true);
    expect(keys.some((k) => k === 'job:job-fencing:stage:blueprint:done')).toBe(true);
    expect(keys.every((k) => !k.includes(':attempt:'))).toBe(true);
  });
});
