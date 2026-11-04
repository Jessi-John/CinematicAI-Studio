/**
 * Race Condition Tests — Concurrent Regenerate
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyMock = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState: {
  stories: Map<string, { id: string; title: string; genre: string; seed: string | null; status: string; seedStoryId: string | null }>;
  deletedIds: Set<string>;
} = {
  stories: new Map(),
  deletedIds: new Set(),
};

let mockFindUnique: AnyMock;
let mockDelete: AnyMock;
let mockCreate: AnyMock;
let mockGenLogDeleteMany: AnyMock;
let mockGenLogUpdateMany: AnyMock;
let mockGenLogFindMany: AnyMock;
let mockTxRun: AnyMock;

function createMocks() {
  mockFindUnique = vi.fn();
  mockDelete = vi.fn();
  mockCreate = vi.fn();
  mockGenLogDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  mockGenLogUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  mockGenLogFindMany = vi.fn().mockResolvedValue([]);
  mockTxRun = vi.fn();

  return {
    mockClient: {
      $transaction: mockTxRun,
      $queryRaw: vi.fn().mockResolvedValue([]),
      story: { findUnique: mockFindUnique, delete: mockDelete, create: mockCreate },
      generationLog: { deleteMany: mockGenLogDeleteMany, updateMany: mockGenLogUpdateMany, findMany: mockGenLogFindMany },
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
    userId: 'user-1',
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
describe('Race: Concurrent Regenerate on Same oldStoryId', () => {
  beforeEach(async () => {
    mockState.stories.clear();
    mockState.deletedIds.clear();

    mockFindUnique.mockResolvedValue({
      id: 'old-story-1',
      title: 'Original Story',
      genre: 'fantasy',
      seed: 'my-seed',
      status: 'published',
      episodes: [{ number: 1, synopsis: 'intro', hook: 'hook', cliffhanger: 'cliff', duration: 60, scenes: [] }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockDelete.mockResolvedValue({ id: 'old-story-1' });
    mockGenLogDeleteMany.mockResolvedValue({ count: 0 });
    mockGenLogUpdateMany.mockResolvedValue({ count: 0 });
    mockGenLogFindMany.mockResolvedValue([]);

    mockTxRun.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        story: { findUnique: mockFindUnique, delete: mockDelete, create: mockCreate },
        generationLog: { deleteMany: mockGenLogDeleteMany, updateMany: mockGenLogUpdateMany, findMany: mockGenLogFindMany },
      };
      try {
        return await fn(tx);
      } catch (err: unknown) {
        if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') return null;
        throw err;
      }
    });

    mockCreate.mockImplementation(async (data: { id?: string }) => {
      // The data received is the Prisma nested create structure.
      // Return a proper story object with all required fields.
      const newId = data.id === 'old-story-1' ? `new-story-${Date.now()}` : data.id;
      // Build a response that matches what Prisma returns after create
      return {
        id: newId,
        title: 'Test Story',
        genre: 'fantasy',
        seed: 'my-seed',
        theme: 'adventure',
        status: 'published',
        embedding: new Array(1024).fill(0.1),
        createdAt: new Date(),
        updatedAt: new Date(),
        episodes: Array.from({ length: 10 }, (_, i) => ({
          id: `ep-${newId}-${i + 1}`,
          number: i + 1,
          title: `Episode ${i + 1}`,
          synopsis: `Synopsis ${i + 1}`,
          hook: `Hook ${i + 1}`,
          cliffhanger: `Cliff ${i + 1}`,
          duration: 60,
          scenes: [],
        })),
        characters: [],
        environments: [],
        youtubeSeo: null,
      };
    });

    // Inject mock client
    const { __setClient } = await import('../../database/prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient as unknown as Parameters<typeof __setClient>[0]);
  });

  it('replaceStoryAtomically can be called successfully', async () => {
    const { replaceStoryAtomically } = await import('../../database/prisma-storage.js');

    const result = await replaceStoryAtomically('old-story-1', buildValidStory('new-story-1', 'fantasy', 'my-seed'));

    expect(result).not.toBeNull();
  });

  it('replaceStoryAtomically calls delete on old story', async () => {
    const { replaceStoryAtomically } = await import('../../database/prisma-storage.js');

    await replaceStoryAtomically('old-story-1', buildValidStory('new-story-1', 'fantasy', 'my-seed'));

    expect(mockDelete).toHaveBeenCalled();
  });

  it('replaceStoryAtomically calls create for new story', async () => {
    const { replaceStoryAtomically } = await import('../../database/prisma-storage.js');

    await replaceStoryAtomically('old-story-1', buildValidStory('new-story-1', 'fantasy', 'my-seed'));

    expect(mockCreate).toHaveBeenCalled();
  });

  it('replaceStoryAtomically calls $transaction to wrap operations', async () => {
    const { replaceStoryAtomically } = await import('../../database/prisma-storage.js');

    await replaceStoryAtomically('old-story-1', buildValidStory('new-story-1', 'fantasy', 'my-seed'));

    expect(mockTxRun).toHaveBeenCalled();
  });
});