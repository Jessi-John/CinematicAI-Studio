/**
 * Tests for buildPreloadedStoryCheckpoint (REGEN-FAST).
 *
 * The orchestrator exposes this pure function so regeneration can
 * pre-seed the candidate JSON and skip stages 1-4. Each test asserts
 * a property of the function that, if it regresses, would cause
 * regeneration to either crash on the pre-load path or fall back to
 * running stages 1-4 unnecessarily.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPreloadedStoryCheckpoint, buildStageContextFromStory, runPostStage5Stages } from './orchestrator.js';
import type { Story } from '../../../services/types.js';

// CRIT-10 regression tests: runPostStage5Stages should invoke stages 7, 9,
// 10, 11 in order. We mock the stage modules so we can observe call order
// without invoking the real AI/network code they wrap.
vi.mock('./stages/stage7-humanization.js', () => ({
  stage7Humanization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./stages/stage9-seo.js', () => ({
  stage9Seo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./stages/stage10-copyright-sweep.js', () => ({
  stage10CopyrightSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./stages/stage11-embedding.js', () => ({
  stage11Embedding: vi.fn().mockResolvedValue(undefined),
}));
// Shared-redis stub so getSharedRedis() doesn't try a real socket.
vi.mock('../../../lib/shared-redis.js', () => ({
  getSharedRedis: () => ({ on: () => {}, ping: async () => 'PONG' }),
}));

const stage7Humanization = (await import('./stages/stage7-humanization.js')).stage7Humanization as unknown as ReturnType<typeof vi.fn>;
const stage9Seo = (await import('./stages/stage9-seo.js')).stage9Seo as unknown as ReturnType<typeof vi.fn>;
const stage10CopyrightSweep = (await import('./stages/stage10-copyright-sweep.js')).stage10CopyrightSweep as unknown as ReturnType<typeof vi.fn>;
const stage11Embedding = (await import('./stages/stage11-embedding.js')).stage11Embedding as unknown as ReturnType<typeof vi.fn>;

const FIXED_DATE = '2024-01-01T00:00:00.000Z';

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: 'orig-1',
    title: 'The Test Story',
    genre: 'fantasy',
    seed: 'a cartographer in a sky-city',
    theme: 'curiosity',
    status: 'complete',
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    characters: [
      {
        id: 'p1', name: 'Arlo', description: 'protagonist', appearance: '',
        personality: '', role: 'protagonist', gender: 'neutral',
      },
      {
        id: 'a1', name: 'Theron', description: 'antagonist', appearance: '',
        personality: '', role: 'antagonist', gender: 'male', arc: 'falls',
      },
      {
        id: 's1', name: 'Lirael', description: 'supporting', appearance: '',
        personality: '', role: 'supporting', gender: 'female',
      },
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
    ...overrides,
  };
}

describe('buildPreloadedStoryCheckpoint', () => {
  it('rebuilds a complete StoryCheckpoint with sidecars for stages 2-4', () => {
    const result = buildPreloadedStoryCheckpoint(makeStory());
    // Sidecars read by the pre-load block (orchestrator.ts:216-248)
    expect(result.protagonistName).toBe('Arlo');
    expect(result.protagonistAge).toBe('Unknown');
    expect(result.setting).toBe('Aeolian Spires');
    expect(result.worldBible).not.toBeNull();
    expect(result.worldBible!.antagonist.name).toBe('Theron');
    expect(result.worldBible!.antagonist.role).toBe('antagonist');
    expect(result.worldBible!.antagonist.arc).toBe('falls');
    expect(result.worldBible!.supporting.name).toBe('Lirael');
    expect(result.worldBible!.supporting.role).toBe('supporting');
    expect(result.worldBible!.environment.name).toBe('Aeolian Spires');
    expect(result.worldBible!.environment.lighting.primary).toBe('natural');
  });

  it('throws when story has no id', () => {
    expect(() => buildPreloadedStoryCheckpoint(makeStory({ id: '' }))).toThrow(/id, title, genre/);
  });

  it('throws when story has no title', () => {
    expect(() => buildPreloadedStoryCheckpoint(makeStory({ title: '' }))).toThrow(/id, title, genre/);
  });

  it('throws when story has no genre', () => {
    expect(() => buildPreloadedStoryCheckpoint(makeStory({ genre: '' as never }))).toThrow(/id, title, genre/);
  });

  it('throws when story has no characters', () => {
    expect(() => buildPreloadedStoryCheckpoint(makeStory({ characters: [] }))).toThrow(/no characters/);
  });

  it('throws when story has no protagonist (no character with role=protagonist)', () => {
    const story = makeStory({
      characters: [
        { id: 'a', name: 'X', description: '', appearance: '', personality: '', role: 'antagonist', gender: 'neutral' },
      ],
    });
    expect(() => buildPreloadedStoryCheckpoint(story)).toThrow(/no protagonist/);
  });

  it('throws when story has no environments', () => {
    expect(() => buildPreloadedStoryCheckpoint(makeStory({ environments: [] }))).toThrow(/no environments/);
  });

  it('falls back to protagonist as antagonist when no antagonist character exists', () => {
    const story = makeStory({
      characters: [
        { id: 'p', name: 'Arlo', description: 'hero', appearance: 'young', personality: 'curious', role: 'protagonist', gender: 'neutral' },
      ],
    });
    const result = buildPreloadedStoryCheckpoint(story);
    // The fallback uses the protagonist's data, but with role='antagonist' so
    // downstream stages treat it as the antagonist slot.
    expect(result.worldBible!.antagonist.name).toBe('Arlo');
    expect(result.worldBible!.antagonist.role).toBe('antagonist');
  });

  it('falls back to protagonist as supporting when no supporting character exists', () => {
    const story = makeStory({
      characters: [
        { id: 'p', name: 'Arlo', description: 'hero', appearance: 'young', personality: 'curious', role: 'protagonist', gender: 'neutral' },
        { id: 'a', name: 'Theron', description: 'villain', appearance: 'old', personality: 'stern', role: 'antagonist', gender: 'male' },
      ],
    });
    const result = buildPreloadedStoryCheckpoint(story);
    expect(result.worldBible!.supporting.name).toBe('Arlo');
    expect(result.worldBible!.supporting.role).toBe('supporting');
  });

  it('uses the FIRST environment as the primary (matching world-bible stage behaviour)', () => {
    const story = makeStory({
      environments: [
        { id: 'e1', name: 'First', description: '', type: 'city', timeOfDay: 'day', weather: 'clear', mood: '', keyFeatures: [], colorPalette: [], lighting: { primary: 'p', ambient: 'a', colorTemperature: 'c', shadows: 'soft' } },
        { id: 'e2', name: 'Second', description: '', type: 'forest', timeOfDay: 'night', weather: 'rain', mood: '', keyFeatures: [], colorPalette: [], lighting: { primary: 'p2', ambient: 'a2', colorTemperature: 'c2', shadows: 'hard' } },
      ],
    });
    const result = buildPreloadedStoryCheckpoint(story);
    expect(result.setting).toBe('First');
    expect(result.worldBible!.environment.name).toBe('First');
  });

  it('preserves all other Story fields verbatim (so the candidate has the full payload)', () => {
    const story = makeStory();
    const result = buildPreloadedStoryCheckpoint(story);
    expect(result.id).toBe(story.id);
    expect(result.title).toBe(story.title);
    expect(result.genre).toBe(story.genre);
    expect(result.seed).toBe(story.seed);
    expect(result.theme).toBe(story.theme);
    expect(result.status).toBe(story.status);
    expect(result.characters).toEqual(story.characters);
    expect(result.environments).toEqual(story.environments);
    expect(result.metadata).toEqual(story.metadata);
  });

  it('STAGE NAMES: stage3 uses underscore, stage4 uses underscore (regression: REGEN-FAST used hyphens and silently failed)', async () => {
    // Read the actual stage source to verify the stage-done names match
    // what the orchestrator writes. If a stage renames its done-flag
    // (e.g. 'character-bible' -> 'character_bible'), the orchestrator's
    // pre-load must be updated in lockstep, otherwise regeneration runs
    // the renamed stage and the previous run's bible is lost.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stage3 = fs.readFileSync(
      path.join(__dirname, 'stages', 'stage3-character-bible.ts'),
      'utf8'
    );
    const stage4 = fs.readFileSync(
      path.join(__dirname, 'stages', 'stage4-world-bible.ts'),
      'utf8'
    );
    // The markStageDone argument must use the underscore form
    expect(stage3).toMatch(/markStageDone\(['"]character_bible['"]\)/);
    expect(stage4).toMatch(/markStageDone\(['"]world_bible['"]\)/);
  });
});

describe('buildStageContextFromStory (CRIT-10)', () => {
  const base = {
    jobId: 'job-1',
    requestId: 'req-1',
    primaryGenre: 'fantasy',
    qualityFloor: 70,
    gradeFloor: 'C',
    aiScoreLimit: 80,
    storyBudget: 50,
    persistMode: 'create' as const,
    seed: 'test seed',
  };

  it('rebuilds the blueprint from the protagonist and first environment', () => {
    const story = makeStory({ episodes: [] });
    const { ctx } = buildStageContextFromStory(story, base);
    expect(ctx.blueprint!.title).toBe('The Test Story');
    expect(ctx.blueprint!.protagonistName).toBe('Arlo');
    expect(ctx.blueprint!.protagonistGender).toBe('neutral');
    expect(ctx.blueprint!.setting).toBe('Aeolian Spires');
    expect(ctx.blueprint!.theme).toBe('curiosity');
    expect(ctx.blueprint!.logline).toBe('a cartographer in a sky-city');
  });

  it('rebuilds characterBible from the protagonist character fields', () => {
    const story = makeStory({ episodes: [] });
    // Make the protagonist have non-default bible fields so we can confirm
    // they were copied through (not just defaults).
    story.characters = [
      {
        id: 'p1', name: 'Arlo', description: '', appearance: '',
        personality: '', role: 'protagonist', gender: 'female',
        speechPatterns: 'wry jokes', clothing: 'leather jacket',
        facialFeatures: 'bold eyes', emotions: ['joy', 'anger'],
        relationships: { Theron: 'rival' }, catchphrases: ['booyah'],
        physicalMannerisms: 'hand gestures',
      },
      ...story.characters.slice(1),
    ];
    const { ctx } = buildStageContextFromStory(story, base);
    // characterBible is rebuilt from the protagonist — assert a non-default
    // field to prove the rebuild copied through (not a fallback instance).
    expect(ctx.characterBible!.speechPatterns).toBe('wry jokes');
    expect(ctx.characterBible!.clothing).toBe('leather jacket');
    expect(ctx.characterBible!.facialFeatures).toBe('bold eyes');
    expect(ctx.characterBible!.emotions).toEqual(['joy', 'anger']);
    expect(ctx.characterBible!.relationships).toEqual({ Theron: 'rival' });
    expect(ctx.characterBible!.catchphrases).toEqual(['booyah']);
    expect(ctx.characterBible!.physicalMannerisms).toBe('hand gestures');
    expect(ctx.characterBible!.gender).toBe('female');
  });

  it('rebuilds the world bible from the antagonist + supporting + environments', () => {
    const story = makeStory({ episodes: [] });
    const { ctx } = buildStageContextFromStory(story, base);
    // worldBible is rebuilt from antagonist/supporting + environments.
    // Verify all three substructures are present.
    expect(ctx.worldBible!.antagonist.name).toBe('Theron');
    expect(ctx.worldBible!.antagonist.role).toBe('antagonist');
    expect(ctx.worldBible!.supporting.name).toBe('Lirael');
    expect(ctx.worldBible!.supporting.role).toBe('supporting');
    expect(ctx.worldBible!.environment.name).toBe('Aeolian Spires');
    expect(ctx.worldBible!.environments.length).toBe(1);
  });

  it('plumbs episodes and story into the stage context', () => {
    const story = makeStory();
    story.episodes = [
      {
        number: 1, title: 'Pixie Crossing', hook: 'h1', synopsis: 's1', cliffhanger: 'c1',
        duration: 50, createdAt: FIXED_DATE, updatedAt: FIXED_DATE,
        scenes: [
          {
            number: 1, duration: 10, narration: { text: 'n1', emotion: 'joy' },
            imagePrompt: { content: 'ip1' }, videoPrompt: { content: 'vp1' },
            cameraDirection: { type: 'wide', movement: 'pan', angle: 'eye', lens: '35mm' },
            transitionType: 'cut', emotionalIntensity: 5,
          },
        ],
      } as never,
    ];
    const { ctx } = buildStageContextFromStory(story, base);
    expect(ctx.episodes!.length).toBe(1);
    expect(ctx.episodes![0]!.title).toBe('Pixie Crossing');
    expect(ctx.story).toBe(story);
  });

  it('returns StageHelpers with stubbed checkpoint helpers (not used by 7/9/10/11)', () => {
    const { helpers } = buildStageContextFromStory(makeStory(), base);
    // Stubs used by stage 7 in its signature destructure only — checked
    // here so future refactors cannot regress without notice.
    expect(typeof helpers.progressEmit).toBe('function');
    expect(typeof helpers.isStageDone).toBe('function');
    expect(typeof helpers.markStageDone).toBe('function');
    expect(typeof helpers.loadCandidate).toBe('function');
    expect(typeof helpers.saveCandidate).toBe('function');
  });
});

describe('runPostStage5Stages (CRIT-10)', () => {
  beforeEach(() => {
    stage7Humanization.mockClear();
    stage9Seo.mockClear();
    stage10CopyrightSweep.mockClear();
    stage11Embedding.mockClear();
  });

  it('invokes stages 7, 9, 10, 11 in order on the supplied context', async () => {
    const { ctx, helpers } = buildStageContextFromStory(makeStory(), {
      jobId: 'job-crit10',
      requestId: 'req-crit10',
      primaryGenre: 'fantasy',
      qualityFloor: 70,
      gradeFloor: 'C',
      aiScoreLimit: 80,
      storyBudget: 50,
      persistMode: 'create',
    });
    await runPostStage5Stages(ctx, helpers);
    expect(stage7Humanization).toHaveBeenCalledTimes(1);
    expect(stage9Seo).toHaveBeenCalledTimes(1);
    expect(stage10CopyrightSweep).toHaveBeenCalledTimes(1);
    expect(stage11Embedding).toHaveBeenCalledTimes(1);
    // stage7 must run before stage9, stage9 before stage10, etc. The mocks
    // run synchronously when their order is enforced by the await chain in
    // runPostStage5Stages; checking mock.invocationOrder verifies this.
    const order = [
      stage7Humanization.mock.invocationCallOrder[0],
      stage9Seo.mock.invocationCallOrder[0],
      stage10CopyrightSweep.mock.invocationCallOrder[0],
      stage11Embedding.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[3]!);
  });

  it('propagates stage 10 safety hard-reject so the caller can fall through to retry', async () => {
    // Stage 10 throws a hard-reject for safety-blocked content. The
    // refinement shortcut in pipeline/index.ts catches this and falls through
    // to the retry path rather than persisting a takedown-liable row. Verify
    // runPostStage5Stages does NOT swallow that throw.
    stage10CopyrightSweep.mockRejectedValueOnce(new Error('Safety-blocked content detected'));
    const { ctx, helpers } = buildStageContextFromStory(makeStory(), {
      jobId: 'job-reject',
      requestId: 'req-reject',
      primaryGenre: 'fantasy',
      qualityFloor: 70,
      gradeFloor: 'C',
      aiScoreLimit: 80,
      storyBudget: 50,
      persistMode: 'create',
    });
    await expect(runPostStage5Stages(ctx, helpers)).rejects.toThrow(/Safety-blocked/);
    // Stage 11 must NOT have run because stage 10 threw before it.
    expect(stage11Embedding).not.toHaveBeenCalled();
  });

  it('throws immediately when abortSignal is already aborted before stage 7', async () => {
    const { ctx, helpers } = buildStageContextFromStory(makeStory(), {
      jobId: 'job-abort',
      requestId: 'req-abort',
      primaryGenre: 'fantasy',
      qualityFloor: 70,
      gradeFloor: 'C',
      aiScoreLimit: 80,
      storyBudget: 50,
      persistMode: 'create',
    });
    const controller = new AbortController();
    controller.abort();
    // stage 7 still runs (it's the first stage); the abort check is
    // BETWEEN stages, so the throw happens after stage 7 returns. We
    // verify stage 9 onward do NOT run when aborted.
    await expect(runPostStage5Stages(ctx, helpers, controller.signal)).rejects.toThrow(/aborted/);
    expect(stage7Humanization).toHaveBeenCalledTimes(1);
    expect(stage9Seo).not.toHaveBeenCalled();
  });
});
