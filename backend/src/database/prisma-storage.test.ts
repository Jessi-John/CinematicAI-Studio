/**
 * Prisma Storage Integration Tests
 *
 * Architecture: Uses __setClient to inject mock PrismaClient before
 * importing prisma-storage. This uses the built-in injection mechanism
 * rather than Jest module mocking which doesn't work reliably in ESM.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Story } from '../services/types.js';
import type { PrismaClient } from '@prisma/client';

type AnyMock = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock functions - created once at module level
// ---------------------------------------------------------------------------
let mockStoryDelete: AnyMock;
let mockStoryCreate: AnyMock;
let mockFindMany: AnyMock;
let mockFindUnique: AnyMock;
let mockGenLogDeleteMany: AnyMock;
let mockGenLogUpdateMany: AnyMock;
let mockGenLogFindMany: AnyMock;
let mockTxRun: AnyMock;

  let mockStoryCount: AnyMock;

function createMocks() {
  mockStoryDelete = vi.fn().mockResolvedValue({ id: 'story-to-delete' });
  mockStoryCreate = vi.fn().mockResolvedValue({
    id: 'mock-id', title: 'Mock Story', genre: 'adventure' as const, seed: null, theme: null,
    status: 'complete' as const, createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'), targetAudience: null, embedding: [],
    isTemplate: false, templateId: null, seedStoryId: null,
    qualityScore: null, qualityGrade: null, humanizationScore: null,
    qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [],
    episodes: [], characters: [], environments: [], youtubeSeo: null,
  });
  mockFindMany = vi.fn().mockResolvedValue([]);
  mockFindUnique = vi.fn().mockResolvedValue({
    id: 'story-to-delete',
    title: 'Story To Delete',
    theme: null,
    seed: null,
    episodes: [],
  });
  mockGenLogDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  mockGenLogUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  mockGenLogFindMany = vi.fn().mockResolvedValue([]);
  mockStoryCount = vi.fn().mockResolvedValue(0);

  mockTxRun = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      story: { delete: mockStoryDelete, create: mockStoryCreate, findMany: mockFindMany, findUnique: mockFindUnique },
      generationLog: { deleteMany: mockGenLogDeleteMany, updateMany: mockGenLogUpdateMany, findMany: mockGenLogFindMany },
      similarityCache: { findMany: mockFindMany },
    };
    return await fn(tx);
  });

  return {
    mockClient: {
      $transaction: mockTxRun,
      $queryRaw: vi.fn().mockResolvedValue([]),
      story: { findMany: mockFindMany, findUnique: mockFindUnique, delete: mockStoryDelete, create: mockStoryCreate, count: mockStoryCount },
      generationLog: { deleteMany: mockGenLogDeleteMany, updateMany: mockGenLogUpdateMany, findMany: mockGenLogFindMany },
      similarityCache: { findMany: mockFindMany },
    } as unknown as PrismaClient,
  };
}

const { mockClient } = createMocks();

// ---------------------------------------------------------------------------
// Story factory
// ---------------------------------------------------------------------------
const FIXED_DATE_ISO = '2024-01-01T00:00:00.000Z';

function makeStory(id: string): Story {
  return {
    id, title: 'Test Story', genre: 'adventure', status: 'complete', userId: 'user-1',
    createdAt: FIXED_DATE_ISO, updatedAt: FIXED_DATE_ISO,
    characters: [], environments: [],
    metadata: {
      totalEpisodes: 10, totalScenes: 50, estimatedDuration: 500,
      targetAudience: '', monetizationScore: 85, viralityScore: 85,
      retentionScore: 88, hookStrength: 90,
    },
    episodes: Array.from({ length: 10 }, (_, ei) => ({
      id: `ep-${ei}`, number: ei + 1, title: `Ep ${ei + 1}`,
      synopsis: 'syn', hook: 'hook', cliffhanger: 'cliff', duration: 50,
      scenes: Array.from({ length: 5 }, (__, si) => ({
        id: `s-${ei}-${si}`, number: si + 1, duration: 10,
        narration: {
          id: `n-${ei}-${si}`,
          text: 'A reasonably long narration line exceeding fifteen characters.',
          timing: { totalDuration: 10, wordsPerMinute: 145, charactersPerMinute: 870 },
          emotion: 'neutral' as const,
        },
        imagePrompt: { id: `i-${ei}-${si}`, type: 'image' as const, content: 'A'.repeat(200), version: 1, createdAt: '' },
        videoPrompt: { id: `v-${ei}-${si}`, type: 'video' as const, content: 'B'.repeat(200), version: 1, createdAt: '' },
        cameraDirection: { type: 'static' as const, movement: 'static', angle: 'medium', lens: 'cinematic' },
        emotionalIntensity: 5, transitionType: 'cut' as const,
        characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' },
        environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] },
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('replaceStoryAtomically', () => {
  beforeEach(async () => {
    // Reset mocks
    mockFindMany.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue({ id: 'story-to-delete', title: 'Story To Delete', theme: null, seed: null, episodes: [] });
    mockStoryDelete.mockResolvedValue({ id: 'story-to-delete' });
    mockStoryCreate.mockResolvedValue({
      id: 'mock-id', title: 'Mock Story', genre: 'adventure' as const, seed: null, theme: null,
      status: 'complete' as const, createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'), targetAudience: null, embedding: [],
      episodes: [], characters: [], environments: [], youtubeSeo: null,
    });
    mockGenLogDeleteMany.mockResolvedValue({ count: 0 });
    mockGenLogUpdateMany.mockResolvedValue({ count: 0 });
    mockGenLogFindMany.mockResolvedValue([]);
    mockTxRun.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        story: { delete: mockStoryDelete, create: mockStoryCreate, findMany: mockFindMany, findUnique: mockFindUnique },
        generationLog: { deleteMany: mockGenLogDeleteMany, updateMany: mockGenLogUpdateMany, findMany: mockGenLogFindMany },
        similarityCache: { findMany: mockFindMany },
      };
      return await fn(tx);
    });

    // Inject mock client
    const { __setClient } = await import('./prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient);
  });

  it('does NOT query SimilarityCache — pgvector HNSW index handles dedupe', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    await replaceStoryAtomically('old-1', makeStory('new-1'));
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('deletes old story BEFORE creating new story (so unique index slot is free)', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    const callOrder: string[] = [];
    mockGenLogFindMany.mockImplementation(async () => { callOrder.push('findMany'); return []; });
    mockStoryDelete.mockImplementation(async () => { callOrder.push('delete'); return { id: 'old-1' }; });
    mockStoryCreate.mockImplementation(async () => {
      callOrder.push('create');
      return {
        id: 'mock-id', title: 'Mock Story', genre: 'adventure' as const, seed: null, theme: null,
        status: 'complete' as const, createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'), targetAudience: null, embedding: [],
        isTemplate: false, templateId: null, seedStoryId: null,
        qualityScore: null, qualityGrade: null, humanizationScore: null,
        qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [],
        episodes: [], characters: [], environments: [], youtubeSeo: null,
      };
    });
    mockGenLogUpdateMany.mockImplementation(async () => { callOrder.push('updateMany'); return { count: 0 }; });
    await replaceStoryAtomically('old-1', makeStory('new-1'));
    expect(mockStoryDelete).toHaveBeenCalledWith({ where: { id: 'old-1' } });
    expect(mockStoryCreate).toHaveBeenCalled();
    expect(mockTxRun).toHaveBeenCalled();
    // The atomic order is: captureLogs(findMany) -> delete old -> create new ->
    // re-point logs (updateMany). delete MUST precede create, otherwise the
    // (genre, deduplicationKey) unique index trips P2002 on the create while the
    // old row is still present. The log re-point (updateMany) MUST come AFTER the
    // create so the immediate generation_logs.storyId FK has a valid target.
    expect(callOrder.indexOf('delete')).toBeLessThan(callOrder.indexOf('create'));
    expect(callOrder.indexOf('findMany')).toBeLessThan(callOrder.indexOf('delete'));
  });

  it('transfers generation logs to the new story AFTER creating it (FK-safe)', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    // Two pre-existing logs on the old story must be re-pointed by primary key
    // (not by storyId) once the replacement row exists.
    mockGenLogFindMany.mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }]);
    await replaceStoryAtomically('old-1', makeStory('new-1'));
    expect(mockGenLogFindMany).toHaveBeenCalledWith({
      where: { storyId: 'old-1' },
      select: { id: true },
    });
    expect(mockGenLogUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['log-1', 'log-2'] } },
      data: { storyId: 'new-1' },
    });
  });

  it('regeneration with same (genre, seed) succeeds and re-points logs after create', async () => {
    // Root-cause regression test (C1): previously the regeneration crashed with
    // P2003 because the logs were re-pointed at the new story BEFORE that row
    // existed (immediate generation_logs.storyId FK). The corrected order is
    // capture -> delete -> create -> re-point: the create frees the unique slot
    // first, and the re-point runs only once the new row satisfies the FK.
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    const newStory = makeStory('new-1');
    const callOrder: string[] = [];
    mockGenLogFindMany.mockImplementation(async () => { callOrder.push('findMany'); return [{ id: 'log-1' }]; });
    mockStoryDelete.mockImplementation(async () => { callOrder.push('delete'); return { id: 'old-1' }; });
    mockStoryCreate.mockImplementation(async () => {
      callOrder.push('create');
      return {
        id: 'new-1', title: 'Mock Story', genre: 'adventure' as const, seed: null, theme: null,
        status: 'complete' as const, createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'), targetAudience: null, embedding: [],
        isTemplate: false, templateId: null, seedStoryId: null,
        qualityScore: null, qualityGrade: null, humanizationScore: null,
        qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [],
        episodes: [], characters: [], environments: [], youtubeSeo: null,
      };
    });
    mockGenLogUpdateMany.mockImplementation(async () => { callOrder.push('updateMany'); return { count: 1 }; });

    const result = await replaceStoryAtomically('old-1', newStory);
    // The corrected order is: findMany(capture) -> delete(old) -> create(new) -> updateMany(re-point).
    expect(callOrder).toEqual(['findMany', 'delete', 'create', 'updateMany']);
    expect(result.id).toBe('new-1');
  });

  it('throws on wrong episode count (invariant)', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    const story = makeStory('new-1');
    story.episodes.splice(5); // → 5 episodes
    await expect(replaceStoryAtomically('old-1', story)).rejects.toThrow(/expected 10 episodes/);
  });

  it('throws on wrong scene count per episode (invariant)', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    const story = makeStory('new-1');
    story.episodes[0]!.scenes.splice(3); // → 3 scenes
    await expect(replaceStoryAtomically('old-1', story)).rejects.toThrow(/has 3 scenes/);
  });

  it('REL-020: defaults viralPotential to 75 (matches createStory default)', async () => {
    const { replaceStoryAtomically } = await import('./prisma-storage.js');
    const story = makeStory('new-1');
    story.youtubeSeo = { title: 't', description: 'd', tags: [], thumbnailSuggestions: [] } as unknown as import('../services/types.js').YouTubeSEO;
    await replaceStoryAtomically('old-1', story);
    // M4 note: mocks accumulate across tests in this file, and youtubeSeo is
    // now only created when the story actually HAS SEO data — so read the
    // create call from THIS test (the last one), not calls[0].
    const createCall = mockStoryCreate.mock.calls.at(-1)?.[0] as { data: { youtubeSeo: { create: { viralPotential: number } } } };
    expect(createCall.data.youtubeSeo.create.viralPotential).toBe(75);
  });
});

describe('deleteStory', () => {
  beforeEach(async () => {
    mockFindMany.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue({ id: 'story-to-delete', title: 'Story To Delete', theme: null, seed: null, episodes: [] });
    mockStoryDelete.mockResolvedValue({ id: 'story-to-delete' });
    mockGenLogDeleteMany.mockResolvedValue({ count: 0 });
    mockTxRun.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        story: { delete: mockStoryDelete, findMany: mockFindMany, findUnique: mockFindUnique },
        generationLog: { deleteMany: mockGenLogDeleteMany },
        similarityCache: { findMany: mockFindMany },
      };
      return await fn(tx);
    });

    const { __setClient } = await import('./prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient);
  });

  it('does NOT query SimilarityCache — pgvector HNSW index handles dedupe', async () => {
    const { deleteStory } = await import('./prisma-storage.js');
    await deleteStory('story-to-delete');
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('clears generation logs then deletes story', async () => {
    const { deleteStory } = await import('./prisma-storage.js');
    await deleteStory('story-to-delete');
    expect(mockGenLogDeleteMany).toHaveBeenCalledWith({ where: { storyId: 'story-to-delete' } });
    expect(mockStoryDelete).toHaveBeenCalledWith({ where: { id: 'story-to-delete' } });
  });

  it('runs inside $transaction', async () => {
    const { deleteStory } = await import('./prisma-storage.js');
    await deleteStory('story-to-delete');
    expect(mockTxRun).toHaveBeenCalled();
  });

  it('returns false when story does not exist', async () => {
    mockStoryDelete.mockImplementationOnce(async () => { throw { code: 'P2025' }; });
    const { deleteStory } = await import('./prisma-storage.js');
    const result = await deleteStory('nonexistent');
    expect(result).toBe(false);
  });
});

describe('getStoryById', () => {
  beforeEach(async () => {
    // Reset mock functions
    mockFindMany.mockResolvedValue([]);
    mockFindUnique.mockReset();
    mockGenLogDeleteMany.mockResolvedValue({ count: 0 });
    mockTxRun.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));

    // Inject mock client
    const { __setClient } = await import('./prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient);
  });

  it('REL-011: includes episodes, characters, environments, youtubeSeo by default (no episodeNumber)', async () => {
    mockFindUnique.mockImplementation(async (_args: unknown) => {
      return {
        id: 'story-1', title: 'A', genre: 'adventure', seed: null, theme: null,
        status: 'complete', createdAt: new Date(), updatedAt: new Date(),
        targetAudience: null, embedding: [], isTemplate: false, templateId: null,
        seedStoryId: null, qualityScore: null, qualityGrade: null, humanizationScore: null,
        qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [],
        episodes: [{ id: 'e1', number: 1, title: 't', synopsis: 's', hook: 'h', cliffhanger: 'c', duration: 50, scenes: [] }],
        characters: [{ id: 'c1' }],
        environments: [{ id: 'env1' }],
        youtubeSeo: { id: 'y1', storyId: 'story-1' },
      };
    });

    const { getStoryById } = await import('./prisma-storage.js');
    await getStoryById('story-1');
    const args = mockFindUnique.mock.calls[0]?.[0] as { include: Record<string, unknown> };
    expect(args?.include).toHaveProperty('episodes');
    expect(args?.include).toHaveProperty('characters');
    expect(args?.include).toHaveProperty('environments');
    expect(args?.include).toHaveProperty('youtubeSeo');
  });

  it('uses episodeNumber fast-path (limit to one episode with 5 scenes) when episodeNumber is provided', async () => {
    mockFindUnique.mockResolvedValue(null);

    const { getStoryById } = await import('./prisma-storage.js');
    await getStoryById('story-1', 3);
    const args = mockFindUnique.mock.calls[0]?.[0] as { include: { episodes: { where: { number: number }; take: number; include: { scenes: { take: number } } } } };
    expect(args?.include?.episodes).toMatchObject({ where: { number: 3 }, take: 1 });
    expect(args?.include?.episodes?.include?.scenes).toMatchObject({ take: 50 });
  });
});

describe('getAllStories', () => {
  beforeEach(async () => {
    mockFindMany.mockReset().mockResolvedValue([]);
    mockFindUnique.mockReset();
    mockStoryCount.mockReset().mockResolvedValue(0);

    const { __setClient } = await import('./prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient);
  });

  it('M41: orders by createdAt desc for newest (default)', async () => {
    const { getAllStories } = await import('./prisma-storage.js');
    await getAllStories({ userId: 'user-1' });
    const args = mockFindMany.mock.calls[0]?.[0] as { orderBy: unknown[] };
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('M41: orders by createdAt asc for oldest', async () => {
    const { getAllStories } = await import('./prisma-storage.js');
    await getAllStories({ userId: 'user-1', sortBy: 'oldest' });
    const args = mockFindMany.mock.calls[0]?.[0] as { orderBy: unknown[] };
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('M41: orders by title asc for title sort', async () => {
    const { getAllStories } = await import('./prisma-storage.js');
    await getAllStories({ userId: 'user-1', sortBy: 'title' });
    const args = mockFindMany.mock.calls[0]?.[0] as { orderBy: unknown[] };
    expect(args.orderBy).toEqual([{ title: 'asc' }, { id: 'asc' }]);
  });

  it('M41 / M3: encodes a base64url cursor for title sort', async () => {
    mockFindMany.mockResolvedValue([
      { id: 's1', title: 'Alpha Story', genre: 'adventure', seed: null, theme: null, status: 'complete', createdAt: new Date('2024-01-01T00:00:00Z'), updatedAt: new Date(), targetAudience: null, qualityScore: null, qualityGrade: null, humanizationScore: null, qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [], episodeCount: 1, sceneCount: 1, youtubeSeo: { viralPotential: 50 } },
      { id: 's2', title: 'Beta Story', genre: 'adventure', seed: null, theme: null, status: 'complete', createdAt: new Date('2024-01-02T00:00:00Z'), updatedAt: new Date(), targetAudience: null, qualityScore: null, qualityGrade: null, humanizationScore: null, qualityRecommendations: [], qualityIssues: [], algorithmTips: [], alternateTitles: [], episodeCount: 1, sceneCount: 1, youtubeSeo: { viralPotential: 50 } },
    ]);
    const { getAllStories } = await import('./prisma-storage.js');
    const result = await getAllStories({ userId: 'user-1', sortBy: 'title', limit: 1 });
    expect(result.hasMore).toBe(true);
    expect(typeof result.nextCursor).toBe('string');
    const cursor = result.nextCursor;
    if (cursor === undefined) throw new Error('expected a nextCursor for a paginated result');
    // The cursor should be decodable and round-trip to the same sort
    const { getAllStories: getAllStories2 } = await import('./prisma-storage.js');
    await getAllStories2({ userId: 'user-1', sortBy: 'title', cursor });
    const args = mockFindMany.mock.calls[1]?.[0] as { where: { OR: unknown[] } };
    expect(args.where.OR).toEqual([
      { title: { gt: 'Alpha Story' } },
      { title: 'Alpha Story', id: { gt: 's1' } },
    ]);
  });
});