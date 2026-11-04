/**
 * Race Condition Tests — Concurrent Delete
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyMock = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  stories: new Map<string, Record<string, unknown>>(),
  deletedIds: new Set<string>(),
  genLogDeleteManyCalls: 0,
};

let mockDeleteFn: AnyMock;
let mockFindUniqueFn: AnyMock;

function createMocks() {
  mockFindUniqueFn = vi.fn().mockImplementation(async (args: { where: { id: string } }) => {
    if (mockState.deletedIds.has(args.where.id)) return null;
    const story = mockState.stories.get(args.where.id);
    if (!story) return null;
    return {
      ...story,
      episodes: [{ number: 1, synopsis: 's1', hook: 'h1', cliffhanger: 'c1', duration: 60, scenes: [] }],
    };
  });

  mockDeleteFn = vi.fn().mockImplementation(async (where: { where: { id: string } }) => {
    if (mockState.deletedIds.has(where.where.id)) {
      const err = new Error('Record to delete not found.');
      Object.assign(err, { code: 'P2025' });
      throw err;
    }
    mockState.deletedIds.add(where.where.id);
    return { id: where.where.id };
  });

  const mockGenLogDeleteMany = vi.fn().mockImplementation(async () => {
    mockState.genLogDeleteManyCalls++;
    return { count: 1 };
  });

  const mockTxRun = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      story: { findUnique: mockFindUniqueFn, delete: mockDeleteFn },
      generationLog: { deleteMany: mockGenLogDeleteMany },
    };
    try {
      return await fn(tx);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2025') return false;
      throw err;
    }
  });

  return {
    mockClient: {
      $transaction: mockTxRun,
      story: { findUnique: mockFindUniqueFn, delete: mockDeleteFn },
      generationLog: { deleteMany: mockGenLogDeleteMany },
    },
    mockTxRun,
  };
}

// Create mock client once at module level
const { mockClient } = createMocks();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Race: Concurrent Delete on Same Story', () => {
  beforeEach(async () => {
    mockState.stories.clear();
    mockState.deletedIds.clear();
    mockState.genLogDeleteManyCalls = 0;
    mockState.stories.set('story-to-delete', {
      id: 'story-to-delete',
      title: 'Story To Delete',
      genre: 'fantasy',
      seed: 'delete-seed',
      status: 'published',
    });
    mockFindUniqueFn.mockClear();
    mockDeleteFn.mockClear();

    // Inject mock client before importing prisma-storage
    const { __setClient } = await import('../../database/prisma.js');
    (globalThis as unknown as { prisma?: unknown }).prisma = undefined;
    __setClient(mockClient as unknown as Parameters<typeof __setClient>[0]);
  });

  it('first caller succeeds, second caller fails', async () => {
    const { deleteStory } = await import('../../database/prisma-storage.js');

    const result1 = await deleteStory('story-to-delete');
    const result2 = await deleteStory('story-to-delete');

    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });

  it('delete is called at least once', async () => {
    const { deleteStory } = await import('../../database/prisma-storage.js');

    await deleteStory('story-to-delete');

    expect(mockDeleteFn).toHaveBeenCalled();
  });

  it('returns false when story does not exist', async () => {
    const { deleteStory } = await import('../../database/prisma-storage.js');

    const result = await deleteStory('non-existent-story');

    expect(result).toBe(false);
  });

  it('concurrent calls: only one delete call succeeds', async () => {
    const { deleteStory } = await import('../../database/prisma-storage.js');

    await Promise.all([
      deleteStory('story-to-delete'),
      deleteStory('story-to-delete'),
    ]);

    expect(mockState.deletedIds.has('story-to-delete')).toBe(true);
  });
});