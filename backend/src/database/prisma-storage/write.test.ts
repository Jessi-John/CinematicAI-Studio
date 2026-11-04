import { describe, it, expect, vi } from 'vitest';

const { prismaMock, setClash } = vi.hoisted(() => {
  let clash = false;
  const prismaMock = {
    $transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        character: {
          findFirst: async () => (clash ? { storyId: 'other-story' } : null),
        },
        story: {
          create: async (args: { data: Record<string, unknown> }) => ({ id: 'new-story', ...args.data }),
        },
      }),
  };
  return { prismaMock, setClash: (v: boolean) => { clash = v; } };
});

vi.mock('../prisma.js', () => ({ prisma: () => prismaMock }));
vi.mock('./converters.js', () => ({ convertStory: (x: unknown) => x }));
vi.mock('./builder.js', () => ({
  buildStoryCreateData: (s: unknown) => s,
  isStoryInput: () => true,
}));
vi.mock('../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/shared-redis.js', () => ({ getSharedRedis: () => ({}) }));

import { createStory } from './write.js';

const baseInput = { genre: 'fantasy', seed: 'a seed', title: 'T' } as unknown as Parameters<typeof createStory>[0];

describe('createStory — protagonist-name uniqueness (race-free)', () => {
  it('throws ProtagonistNameCollisionError when a completed story already uses the name', async () => {
    setClash(true);
    await expect(createStory(baseInput, { protagonistName: 'Tessa' })).rejects.toThrow(
      /already used by a committed story/
    );
  });

  it('creates the story when the protagonist name is available', async () => {
    setClash(false);
    const r = await createStory(baseInput, { protagonistName: 'BrandNewName' });
    expect((r as { id: string }).id).toBe('new-story');
  });

  it('skips the clash check entirely when no protagonistName is provided', async () => {
    setClash(true); // would clash, but no name given → no check → create proceeds
    const r = await createStory(baseInput);
    expect((r as { id: string }).id).toBe('new-story');
  });
});
