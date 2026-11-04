/**
 * Race Condition Tests — Concurrent Story Creation with Same Seed
 *
 * Tests concurrent story creation behavior. createStory wraps the insert in a
 * Serializable $transaction (protagonist-name uniqueness + story.create run in
 * one transaction), so the mocked $transaction must invoke its callback with a
 * transaction-scoped client for the create to run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StoryInput } from '../../database/prisma-storage/builder.js';

type AnyMock = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState: {
  stories: Map<string, { id: string; genre: string; seed: string | null; title: string }>;
} = {
  stories: new Map(),
};

let mockFindMany: AnyMock;
let mockCreate: AnyMock;
let mockCharacterFindFirst: AnyMock;

function createMocks() {
  mockFindMany = vi.fn().mockResolvedValue([]);
  mockCreate = vi.fn();
  mockCharacterFindFirst = vi.fn().mockResolvedValue(null);

  // createStory wraps story.create in prisma.$transaction(async (tx) => {...}).
  // The mock must invoke the callback with a tx that routes story.create and
  // character.findFirst to our spies; a bare vi.fn() returns undefined and the
  // create never runs.
  const tx = {
    character: { findFirst: mockCharacterFindFirst },
    story: { findMany: mockFindMany, create: mockCreate },
  };

  return {
    mockClient: {
      $transaction: vi.fn(async (cb: (txArg: unknown) => unknown) => cb(tx)),
      $queryRaw: vi.fn().mockResolvedValue([]),
      story: { findMany: mockFindMany, create: mockCreate },
    },
  };
}

const { mockClient } = createMocks();

// ---------------------------------------------------------------------------
// Helper: build a valid story object
// ---------------------------------------------------------------------------
function buildValidStory(id: string, genre: string, seed: string | null): Record<string, unknown> {
  return {
    id,
    title: 'Test Story',
    genre,
    seed,
    theme: 'adventure',
    status: 'published',
    embedding: new Array(1024).fill(0.1),
    metadata: {
      targetAudience: 'general',
      qualityScore: 85,
      qualityGrade: 'A',
      humanizationScore: 90,
      qualityRecommendations: [],
      qualityIssues: [],
      algorithmTips: [],
      alternateTitles: [],
    },
    youtubeSeo: {
      title: 'Test SEO',
      description: 'Test description',
      tags: ['test'],
      thumbnailSuggestions: [],
      videoTemplate: 'standard',
      hookScript: 'Hook here',
      algorithmBoostTips: [],
      viralPotential: 80,
      recommendedDuration: '10:00',
      targetAudience: 'general',
      trendingKeywords: [],
      ctaScript: 'Subscribe!',
    },
    characters: [
      {
        id: `char-${id}`,
        name: 'Hero',
        description: 'A brave hero',
        appearance: 'Bold',
        personality: 'Brave',
        role: 'protagonist',
        speechPatterns: 'Clear',
        clothing: 'Adventurous',
        facialFeatures: 'Strong',
        emotions: ['curiosity'],
        relationships: {},
        catchphrases: ['Onward!'],
        physicalMannerisms: 'Steady',
      },
    ],
    environments: [
      {
        id: `env-${id}`,
        name: 'Forest',
        description: 'A mystical forest',
        type: 'fantasy',
        timeOfDay: 'day',
        weather: 'clear',
        mood: 'adventurous',
        keyFeatures: ['trees', 'streams'],
        colorPalette: ['green', 'brown'],
        lighting: { primary: 'sunlight', ambient: 'soft', colorTemperature: 'warm', shadows: 'soft' },
      },
    ],
    episodes: Array.from({ length: 10 }, (_, i) => ({
      id: `ep-${id}-${i + 1}`,
      number: i + 1,
      title: `Episode ${i + 1}`,
      synopsis: `Synopsis for episode ${i + 1}`,
      hook: `Hook ${i + 1}`,
      cliffhanger: `Cliffhanger ${i + 1}`,
      duration: 60,
      voiceoverScript: null,
      voiceoverText: null,
      musicSuggestions: [],
      soundDesign: [],
      scenes: Array.from({ length: 5 }, (_, j) => ({
        id: `sc-${id}-${i + 1}-${j + 1}`,
        number: j + 1,
        duration: 12,
        narration: {
          text: 'This is sample narration text that is long enough to pass validation checks',
          emotion: 'neutral',
          timing: { totalDuration: 15, wordsPerMinute: 150, charactersPerMinute: 900 },
        },
        imagePrompt: {
          content: 'A detailed image prompt that is definitely longer than one hundred characters for validation purposes here',
          version: '1.0',
        },
        videoPrompt: {
          content: 'A detailed video prompt that is definitely longer than one hundred characters for validation purposes here',
          version: '1.0',
        },
        cameraDirection: {
          type: 'cinematic',
          movement: 'tracking',
          angle: 'wide',
          lens: 'medium',
        },
        characterState: {
          characterId: `char-${id}`,
          position: 'center',
          action: 'standing',
          emotion: 'neutral',
          expression: 'calm',
          bodyLanguage: 'natural',
        },
        environmentState: {
          environmentId: `env-${id}`,
          timeOfDay: 'day',
          weather: 'clear',
          lighting: 'natural',
          atmosphere: 'calm',
          ambientSounds: [],
        },
        emotionalIntensity: 0.5,
        transitionType: 'cut',
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Race: Concurrent Story Creation with Same Seed', () => {
  beforeEach(async () => {
    mockState.stories.clear();

    mockFindMany.mockClear();
    mockCreate.mockClear();
    mockFindMany.mockResolvedValue([]);

    mockCreate.mockImplementation(async (data: { id?: string }) => {
      const id = data.id || `story-${Date.now()}`;
      return { id, ...data, createdAt: new Date(), updatedAt: new Date() };
    });

    // Inject mock client
    const { __setClient } = await import('../../database/prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient as unknown as Parameters<typeof __setClient>[0]);
  });

  it('createStory can be called successfully', async () => {
    const { createStory } = await import('../../database/prisma-storage.js');

    const result = await createStory(buildValidStory('story-1', 'fantasy', 'unique-seed-1') as unknown as StoryInput);

    expect(result).not.toBeNull();
    expect(typeof result?.id).toBe('string');
  });

  it('createStory calls story.create to persist', async () => {
    const { createStory } = await import('../../database/prisma-storage.js');

    await createStory(buildValidStory('story-1', 'fantasy', 'unique-seed-2') as unknown as StoryInput);

    expect(mockCreate).toHaveBeenCalled();
  });

  it('createStory passes seed as deduplicationKey by default', async () => {
    const { createStory } = await import('../../database/prisma-storage.js');

    await createStory(buildValidStory('story-1', 'fantasy', 'shared-seed') as unknown as StoryInput);

    expect(mockCreate).toHaveBeenCalled();
    const data = mockCreate.mock.calls[0]![0] as { data?: { deduplicationKey?: string | null; seed?: string | null } };
    expect(data.data?.deduplicationKey).toBe('shared-seed');
    expect(data.data?.seed).toBe('shared-seed');
  });

  it('createStory uses explicit deduplicationKey when forceNew is set', async () => {
    const { createStory } = await import('../../database/prisma-storage.js');

    await createStory({
      ...buildValidStory('story-1', 'fantasy', 'shared-seed'),
      deduplicationKey: 'shared-seed::forceNew::job-123',
    } as unknown as StoryInput);

    const data = mockCreate.mock.calls[0]![0] as { data?: { deduplicationKey?: string | null; seed?: string | null } };
    expect(data.data?.deduplicationKey).toBe('shared-seed::forceNew::job-123');
    expect(data.data?.seed).toBe('shared-seed');
  });

  it('two concurrent forceNew creates with the same seed use different deduplicationKeys', async () => {
    const { createStory } = await import('../../database/prisma-storage.js');

    await Promise.all([
      createStory({
        ...buildValidStory('story-1', 'fantasy', 'shared-seed'),
        deduplicationKey: 'shared-seed::forceNew::job-1',
      } as unknown as StoryInput),
      createStory({
        ...buildValidStory('story-2', 'fantasy', 'shared-seed'),
        deduplicationKey: 'shared-seed::forceNew::job-2',
      } as unknown as StoryInput),
    ]);

    const keys = mockCreate.mock.calls.map((call) => {
      const data = call[0] as { data?: { deduplicationKey?: string | null } };
      return data.data?.deduplicationKey;
    });
    expect(new Set(keys).size).toBe(2);
  });
});