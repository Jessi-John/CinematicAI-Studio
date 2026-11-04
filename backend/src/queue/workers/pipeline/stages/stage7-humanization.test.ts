import { describe, it, expect, vi } from 'vitest';
import type { Story, Episode, Scene } from '../../../../services/types.js';
import type { StageContext, StageHelpers } from '../types.js';
import type { CharacterBible } from '../../../../services/character-bible.js';
import type { StoryBlueprint } from '../../../../lib/episode-generator.js';

vi.mock('../../../../humanization/index.js', () => {
  const mockDetectRepetition = vi.fn(() => ({
    hasRepetition: false,
    repeatedPhrases: [] as string[],
    similarityScore: 0,
  }));
  return {
    humanization: {
      process: vi.fn((text: unknown) => {
        const t = String(text);
        // bad_ = AI-like prose (low score, below threshold) → triggers retry
        // good_ = human-like prose (high score, at/above threshold) → no retry
        if (t.startsWith('bad_')) {
          return { text: t, changes: [], aiScore: 30, lowScoreSentences: [] };
        }
        return { text: t, changes: [], aiScore: 95, lowScoreSentences: [] };
      }),
      detectRepetition: mockDetectRepetition,
    },
  };
});

vi.mock('../../../../lib/episode-generator.js', async () => ({
  generateSingleScene: vi.fn(async () => 'regenerated_good_text'),
  fixPronounMismatches: vi.fn((text: string) => ({ text, changes: [] as string[] })),
  isStrongCliffhanger: vi.fn(() => true),
  isStrongGenreEnding: vi.fn(() => true),
  evaluateCliffhangerSemantic: vi.fn(async () => true),
}));

vi.mock('../../../../lib/tts-normalize.js', () => ({
  buildVoiceoverText: vi.fn(({ hook, scenes }: { hook: string; scenes: string[] }) =>
    `voiceover_${hook}_${scenes.length}scenes`
  ),
}));

vi.mock('../../../../services/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeMockScene(number: number, text: string): Scene {
  return {
    id: `scene-${number}`,
    number,
    duration: 10,
    narration: { id: 'n-1', text, timing: { totalDuration: 10, wordsPerMinute: 150, charactersPerMinute: 750 }, emotion: 'neutral' },
    imagePrompt: { id: 'ip-1', type: 'image', content: '', version: 1, createdAt: new Date().toISOString() },
    videoPrompt: { id: 'vp-1', type: 'video', content: '', version: 1, createdAt: new Date().toISOString() },
    cameraDirection: { type: 'static', movement: 'none', angle: 'eye-level', lens: '50mm' },
    emotionalIntensity: 5,
    transitionType: 'cut',
    characterState: { characterId: 'c-1', position: 'center', action: 'standing', emotion: 'neutral', expression: 'neutral', bodyLanguage: 'relaxed' },
    environmentState: { environmentId: 'e-1', timeOfDay: 'day', weather: 'clear', lighting: 'bright', atmosphere: 'neutral', ambientSounds: [] },
  };
}

function makeMockEpisode(number: number, sceneTexts: string[]): Episode {
  return {
    id: `ep-${number}`,
    number,
    title: `Episode ${number}`,
    synopsis: `Synopsis ${number}`,
    hook: `Hook ${number}`,
    cliffhanger: `Cliffhanger ${number}`,
    duration: 50,
    scenes: sceneTexts.map((t, i) => makeMockScene(i + 1, t)),
  };
}

function makeMockContext(overrides?: Partial<StageContext>): StageContext {
  const episodes = [makeMockEpisode(1, ['good_text_1a', 'good_text_1b', 'bad_1c']), makeMockEpisode(2, ['good_text_2a', 'bad_2b', 'good_text_2c'])];
  const story: Story = {
    id: 'test-story',
    title: 'Test Story',
    genre: 'fantasy',
    status: 'generating',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    episodes: episodes as unknown as Story['episodes'],
    characters: [],
    environments: [],
    metadata: {
      totalEpisodes: 2,
      totalScenes: 6,
      estimatedDuration: 300,
      targetAudience: 'all',
      monetizationScore: 70,
      viralityScore: 70,
      retentionScore: 70,
      hookStrength: 70,
    },
  };
  const blueprint: StoryBlueprint = {
    title: 'Test Story',
    protagonistName: 'Hero',
    protagonistAge: '20',
    setting: 'Fantasy World',
    theme: 'adventure',
    logline: 'A hero adventures.',
  };
  const characterBible: CharacterBible = {
    speechPatterns: 'Normal',
    clothing: 'Adventurer gear',
    facialFeatures: 'Determined',
    emotions: ['bravery'],
    relationships: {},
    catchphrases: [],
    physicalMannerisms: 'Confident',
    gender: 'female',
  };
  return {
    primaryGenre: 'fantasy',
    seed: 'test-seed',
    jobId: 'test-job',
    requestId: 'test-req',
    qualityFloor: 50,
    gradeFloor: 'C',
    aiScoreLimit: overrides?.aiScoreLimit ?? 80,
    storyBudget: overrides?.storyBudget ?? 2,
    persistMode: 'return-candidate',
    episodesPerStory: 10,
    scenesPerEpisode: 5,
    targetWordsPerScene: 50,
    targetEpisodeWordsMin: 200,
    targetEpisodeWordsMax: 300,
    sceneDurationMinSeconds: 10,
    sceneDurationMaxSeconds: 30,
    speakingWpm: 150,
    targetEpisodeSeconds: 300,
    blueprint,
    characterBible,
    story,
    ...overrides,
  };
}

const mockHelpers: StageHelpers = {
  redis: null as never,
  progressEmit: vi.fn().mockResolvedValue(undefined),
  isStageDone: vi.fn().mockResolvedValue(true),
  markStageDone: vi.fn().mockResolvedValue(undefined),
  loadCandidate: vi.fn().mockResolvedValue(null),
  saveCandidate: vi.fn().mockResolvedValue(undefined),
};

describe('stage7Humanization', () => {
  it('processes all scenes in parallel and writes results back', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 10 });

    await stage7Humanization(ctx, mockHelpers);

    const story = ctx.story!;
    const allTexts = story.episodes.flatMap((ep) => ep.scenes.map((s) => s.narration.text));
    expect(allTexts).toHaveLength(6);
    // "bad_" scenes should be regenerated (aiScore 30 < limit 80 = AI-like)
    expect(allTexts.filter((t) => t === 'regenerated_good_text')).toHaveLength(2);
    // "good_" scenes should remain unchanged (aiScore 95 >= limit 80 = human-like)
    expect(allTexts.filter((t) => t.startsWith('good_text_'))).toHaveLength(4);
  });

  it('builds voiceoverText per episode after all scenes processed', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 10 });

    await stage7Humanization(ctx, mockHelpers);

    const story = ctx.story!;
    for (const ep of story.episodes) {
      // After stage 7 runs, voiceoverText must be a non-empty string
      // that incorporates the episode number and scene count. A literal
      // empty string would indicate the humanization pass failed silently.
      expect(ep.voiceoverText?.length).toBeGreaterThan(0);
      expect(ep.voiceoverText).toContain(`Hook ${ep.number}`);
      expect(ep.voiceoverText).toContain(`${ep.scenes.length}scenes`);
    }
  });

  it('computes average humanization score', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 10 });

    await stage7Humanization(ctx, mockHelpers);

    const story = ctx.story!;
    expect(story.metadata.humanizationScore).toBeGreaterThan(0);
    expect(story.metadata.humanizationScore).toBeLessThanOrEqual(100);
  });

  it('respects storyBudget limit for retries beyond the first per scene', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    // Budget of 1: each scene gets 1 free regen (first attempt always allowed),
    // so both bad scenes regenerate once. The budget gates SECOND retries.
    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 1 });

    await stage7Humanization(ctx, mockHelpers);

    const story = ctx.story!;
    const allTexts = story.episodes.flatMap((ep) => ep.scenes.map((s) => s.narration.text));
    // Both "bad_" scenes regenerate once (first retry is always free)
    const regenCount = allTexts.filter((t) => t === 'regenerated_good_text').length;
    expect(regenCount).toBe(2);
  });

  it('handles empty episodes gracefully', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const ctx = makeMockContext();
    ctx.story!.episodes = [];

    await stage7Humanization(ctx, mockHelpers);

    expect(ctx.story!.metadata.humanizationScore).toBe(100);
  });

  it('detects and regenerates cross-scene repetition', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const { humanization } = await import('../../../../humanization/index.js');

    // Force ALL scenes to be flagged as repetitive on the initial check.
    // This means the diversity gate (>30% flagged) will fire and abort the pass
    // after the first few scenes — proving the diversity gate works.
    vi.mocked(humanization.detectRepetition).mockImplementation(
      () => ({
        hasRepetition: true,
        repeatedPhrases: ['forced repetition'],
        similarityScore: 0.95,
      })
    );

    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 10 });
    // Set aiScoreLimit below 30 so the parallel pass does NOT retry any scenes.
    ctx.aiScoreLimit = 20;

    await stage7Humanization(ctx, mockHelpers);

    const story = ctx.story!;
    // Diversity gate (>30% flagged with checked >= 3) should have aborted the
    // repetition pass before the budget was exhausted. No scenes should have
    // been regenerated because every one was flagged.
    const allTexts = story.episodes.flatMap((ep) => ep.scenes.map((s) => s.narration.text));
    expect(allTexts.filter((t) => t === 'regenerated_good_text')).toHaveLength(0);
  });

  // FIX: When detectRepetition returns hasRepetition=true but
  // repeatedPhrases is empty, it means the flag was caused by unavoidable
  // vocabulary overlap (same protagonist, same setting terms) rather than
  // actual repeated trigrams. The stage must NOT waste an API call
  // regenerating — the retry would produce the same overlap.
  it('skips regeneration when repetition is only from vocab overlap (repeatedPhrases=[])', async () => {
    const { stage7Humanization } = await import('./stage7-humanization.js');
    const { humanization } = await import('../../../../humanization/index.js');
    const { generateSingleScene } = await import('../../../../lib/episode-generator.js');

    // Mock detectRepetition to return hasRepetition=true but no actual
    // repeated phrases — this simulates the vocabulary-overlap case.
    vi.mocked(humanization.detectRepetition).mockImplementation(
      () => ({
        hasRepetition: true,
        repeatedPhrases: [],  // <-- empty: vocab overlap only
        similarityScore: 0.85,
      })
    );

    const ctx = makeMockContext({ aiScoreLimit: 80, storyBudget: 10 });
    ctx.aiScoreLimit = 20; // Prevent parallel pass from triggering

    // Reset the mock call count
    vi.mocked(generateSingleScene).mockClear();

    await stage7Humanization(ctx, mockHelpers);

    // generateSingleScene should NOT have been called for the repetition
    // pass, because repeatedPhrases was empty (vocab overlap only).
    expect(generateSingleScene).not.toHaveBeenCalled();
  });
});
