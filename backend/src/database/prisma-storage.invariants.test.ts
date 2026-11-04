/**
 * Story-level invariant tests for createStory.
 *
 * The invariants (10 episodes, 5 scenes per episode, prompts ≥ 100 chars,
 * narration ≥ 15 chars, embedding dim 1024) run BEFORE any prisma call.
 * The test imports the real exported validator from prisma-storage.ts so
 * any drift in the production code is caught here.
 */

import { describe, it, expect } from 'vitest';
import { validateStoryInvariants, validateEmbedding } from './prisma-storage/validation.js';
import type { Story } from '../services/types.js';

// ── Story factory ──────────────────────────────────────────────────────────
function makeStory(overrides: {
  episodeCount: number;
  scenesPerEpisode: number;
  imagePromptLen?: number;
  videoPromptLen?: number;
  narrationLen?: number;
}): Story {
  const {
    episodeCount,
    scenesPerEpisode,
    imagePromptLen = 200,
    videoPromptLen = 200,
    narrationLen = 40,
  } = overrides;

  // Build prompts of exact specified length (minus the fixed label prefix).
  // image prompt label = "image prompt " = 13 chars
  // video prompt label = "video prompt " = 13 chars
  const imgContent = `image prompt ${'x'.repeat(Math.max(0, imagePromptLen - 13))}`;
  const vidContent = `video prompt ${'x'.repeat(Math.max(0, videoPromptLen - 13))}`;
  const narBase = 'A reasonably long narration line for this scene.';
  const narText = narBase.repeat(Math.ceil(narrationLen / narBase.length)).slice(0, narrationLen);

  return {
    id: 's-1',
    title: 'stub',
    genre: 'fantasy',
    status: 'complete',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    characters: [],
    environments: [],
    metadata: {
      totalEpisodes: episodeCount,
      totalScenes: episodeCount * scenesPerEpisode,
      estimatedDuration: 50 * episodeCount,
      targetAudience: '',
      monetizationScore: 0,
      viralityScore: 0,
      retentionScore: 0,
      hookStrength: 0,
    },
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      id: `ep-${i}`,
      number: i + 1,
      title: `Ep ${i + 1}`,
      synopsis: 'syn',
      hook: 'hook',
      cliffhanger: 'cliff',
      duration: 50,
      scenes: Array.from({ length: scenesPerEpisode }, (__, j) => ({
        id: `s-${i}-${j}`,
        number: j + 1,
        duration: 10,
        narration: {
          id: `n-${i}-${j}`,
          text: narText,
          timing: { totalDuration: 10, wordsPerMinute: 145, charactersPerMinute: 870 },
          emotion: 'neutral' as const,
        },
        imagePrompt: { id: `i-${i}-${j}`, type: 'image' as const, content: imgContent, version: 1, createdAt: '' },
        videoPrompt: { id: `v-${i}-${j}`, type: 'video' as const, content: vidContent, version: 1, createdAt: '' },
        cameraDirection: { type: 'static' as const, movement: 'static', angle: 'medium', lens: 'cinematic' },
        emotionalIntensity: 5,
        transitionType: 'cut' as const,
        characterState: {
          characterId: '',
          position: 'center',
          action: 'still',
          emotion: 'neutral',
          expression: 'calm',
          bodyLanguage: 'natural',
        },
        environmentState: {
          environmentId: '',
          timeOfDay: 'day',
          weather: 'clear',
          lighting: 'natural',
          atmosphere: 'calm',
          ambientSounds: [],
        },
      })),
    })),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────
// Note: The source `validateStoryInvariants` enforces 10 episodes / 5 scenes
// per episode / prompt length ≥ 100 / narration.trim length ≥ 15. The
// embedding dimension check lives in `validateEmbedding`, which is called
// separately by `buildStoryCreateData`. We cover both through this test.
describe('createStory invariants', () => {
  it('rejects fewer than 10 episodes', () => {
    const story = makeStory({ episodeCount: 9, scenesPerEpisode: 5 });
    expect(() => validateStoryInvariants(story)).toThrow(/expected 10 episodes/);
  });

  it('rejects more than 10 episodes', () => {
    const story = makeStory({ episodeCount: 11, scenesPerEpisode: 5 });
    expect(() => validateStoryInvariants(story)).toThrow(/expected 10 episodes/);
  });

  it('rejects 0 episodes', () => {
    const story = makeStory({ episodeCount: 0, scenesPerEpisode: 5 });
    expect(() => validateStoryInvariants(story)).toThrow(/expected 10 episodes/);
  });

  it('rejects non-five scenes per episode', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 4 });
    expect(() => validateStoryInvariants(story)).toThrow(/4 scenes/);
  });

  it('rejects 0 scenes per episode', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 0 });
    expect(() => validateStoryInvariants(story)).toThrow(/0 scenes/);
  });

  it('rejects image prompts shorter than 100 chars', () => {
    // imagePromptLen=87 → content=87 chars, < 100, fails the imagePrompt check
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 87, videoPromptLen: 200 });
    expect(() => validateStoryInvariants(story)).toThrow(/imagePrompt too short/);
  });

  it('rejects video prompts shorter than 100 chars', () => {
    // imagePromptLen=200 (≥100, passes), videoPromptLen=87 (<100, fails video check)
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 200, videoPromptLen: 87 });
    expect(() => validateStoryInvariants(story)).toThrow(/videoPrompt too short/);
  });

  it('rejects narration shorter than 15 chars', () => {
    // narrationLen=1 → 'A' (1 char after trim, < 15)
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, narrationLen: 1 });
    expect(() => validateStoryInvariants(story)).toThrow(/narration too short/);
  });

  it('accepts a fully-formed story', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  // ── Boundary tests ──

  it('rejects 6 scenes per episode (over)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 6 });
    expect(() => validateStoryInvariants(story)).toThrow(/6 scenes/);
  });

  it('rejects 9 scenes per episode (under)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 9 });
    expect(() => validateStoryInvariants(story)).toThrow(/9 scenes/);
  });

  it('rejects 1 scene per episode', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 1 });
    expect(() => validateStoryInvariants(story)).toThrow(/1 scenes/);
  });

  it('rejects 100 scenes per episode (perf-008 circuit breaker)', () => {
    // Per prisma-storage.ts PERF-008: no story should have more than 100 scenes.
    // This is enforced at the prisma take limit, but the invariant should
    // also fail at the storage layer if it ever got that far.
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 100 });
    expect(() => validateStoryInvariants(story)).toThrow(/100 scenes/);
  });

  // Prompt length boundary tests
  it('rejects image prompt of exactly 99 chars (one below min)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 99 });
    expect(() => validateStoryInvariants(story)).toThrow(/imagePrompt too short/);
  });

  it('accepts image prompt of exactly 100 chars (boundary)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 100 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  it('accepts image prompt of exactly 101 chars (one above min)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 101 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  it('rejects video prompt of exactly 99 chars (one below min)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, videoPromptLen: 99 });
    expect(() => validateStoryInvariants(story)).toThrow(/videoPrompt too short/);
  });

  it('accepts video prompt of exactly 100 chars (boundary)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, videoPromptLen: 100 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  // Narration boundary tests
  it('rejects narration of exactly 14 chars (one below min)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, narrationLen: 14 });
    expect(() => validateStoryInvariants(story)).toThrow(/narration too short/);
  });

  it('accepts narration of exactly 15 chars (boundary)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, narrationLen: 15 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  it('accepts narration of exactly 16 chars (one above min)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, narrationLen: 16 });
    expect(() => validateStoryInvariants(story)).not.toThrow();
  });

  it('rejects narration of 30 chars but 20 are whitespace (trim check)', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, narrationLen: 30 });
    // The makeStory factory generates narration from a base string repeated.
    // We need to manually inject whitespace to test the trim behavior.
    if (story.episodes[0]?.scenes[0]?.narration) {
      story.episodes[0].scenes[0].narration.text = '   ' + 'x'.repeat(10) + '   '; // 16 chars but trims to 10
    }
    expect(() => validateStoryInvariants(story)).toThrow(/narration too short/);
  });

  it('rejects narration of only whitespace', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5 });
    if (story.episodes[0]?.scenes[0]?.narration) {
      story.episodes[0].scenes[0].narration.text = '     '; // 5 spaces
    }
    expect(() => validateStoryInvariants(story)).toThrow(/narration too short/);
  });

  it('rejects narration of empty string', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5 });
    if (story.episodes[0]?.scenes[0]?.narration) {
      story.episodes[0].scenes[0].narration.text = '';
    }
    expect(() => validateStoryInvariants(story)).toThrow(/narration too short/);
  });

  // Embedding dimension tests (validateEmbedding — separate from story invariants)
  it('accepts story with no embedding (zero-length)', () => {
    // When embedding is missing or empty, validateEmbedding returns [] so the
    // story persists (partial HNSW index excludes it; background worker
    // backfills the vector later). Returning null was the persistence bug.
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5 });
    story.embedding = [];
    expect(() => validateStoryInvariants(story)).not.toThrow();
    expect(validateEmbedding(story.embedding)).toEqual([]);
  });

  it('accepts embedding of exactly 1024 dimensions', () => {
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5 });
    story.embedding = new Array(1024).fill(0.1);
    expect(() => validateStoryInvariants(story)).not.toThrow();
    const result = validateEmbedding(story.embedding);
    expect(result).toHaveLength(1024);
  });

  it('rejects embedding of 1023 dimensions (one below expected)', () => {
    expect(() => validateEmbedding(new Array(1023).fill(0.1))).toThrow(/embedding dimension is 1023/);
  });

  it('rejects embedding of 1025 dimensions (one above expected)', () => {
    expect(() => validateEmbedding(new Array(1025).fill(0.1))).toThrow(/embedding dimension is 1025/);
  });

  it('rejects embedding of 4096 dimensions (untruncated)', () => {
    expect(() => validateEmbedding(new Array(4096).fill(0.1))).toThrow(/embedding dimension is 4096/);
  });

  it('returns [] for undefined embedding (regression: null broke Prisma list validation)', () => {
    expect(validateEmbedding(undefined)).toEqual([]);
  });

  it('returns [] for null embedding (regression: null broke Prisma list validation)', () => {
    expect(validateEmbedding(null)).toEqual([]);
  });

  // Multiple invariants violated
  it('reports the FIRST violated invariant (early throw)', () => {
    // Story with multiple problems: wrong episode count, wrong scene count,
    // short prompts, short narration. The first check (episode count) should fail.
    const story = makeStory({ episodeCount: 5, scenesPerEpisode: 3, imagePromptLen: 50 });
    expect(() => validateStoryInvariants(story)).toThrow(/expected 10 episodes/);
  });

  it('reports scene count invariant before prompt length', () => {
    // Right episode count, wrong scene count, short prompts
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 3, imagePromptLen: 50 });
    expect(() => validateStoryInvariants(story)).toThrow(/3 scenes/);
  });

  it('reports image prompt invariant before video prompt', () => {
    // Right structure, short image, short video. Image should be reported first.
    const story = makeStory({ episodeCount: 10, scenesPerEpisode: 5, imagePromptLen: 50, videoPromptLen: 50 });
    expect(() => validateStoryInvariants(story)).toThrow(/imagePrompt too short/);
  });
});
