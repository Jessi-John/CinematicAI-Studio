import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../middleware/error.js';

vi.mock('../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/prisma.js', () => {
  let sceneRow: { id: string; version: number; narrationText: string; episodeId: string; episode: { story: { id: string; userId: string } } } = {
    id: 'sc-1',
    version: 2,
    narrationText: 'Original narration text that is long enough for the validator.',
    episodeId: 'ep-1',
    episode: { story: { id: 'story-1', userId: 'user-1' } },
  };

  let episodeRow: { id: string; version: number; title: string; hook: string; synopsis: string; cliffhanger: string; story: { id: string; userId: string } } = {
    id: 'ep-1',
    version: 3,
    title: 'Original Title',
    hook: 'Original hook.',
    synopsis: 'Original synopsis.',
    cliffhanger: 'Original cliffhanger.',
    story: { id: 'story-1', userId: 'user-1' },
  };

  const sceneUpdateCalls: unknown[] = [];
  const episodeUpdateCalls: unknown[] = [];

  function reset() {
    sceneRow = {
      id: 'sc-1',
      version: 2,
      narrationText: 'Original narration text that is long enough for the validator.',
      episodeId: 'ep-1',
      episode: { story: { id: 'story-1', userId: 'user-1' } },
    };
    episodeRow = {
      id: 'ep-1',
      version: 3,
      title: 'Original Title',
      hook: 'Original hook.',
      synopsis: 'Original synopsis.',
      cliffhanger: 'Original cliffhanger.',
      story: { id: 'story-1', userId: 'user-1' },
    };
    sceneUpdateCalls.length = 0;
    episodeUpdateCalls.length = 0;
  }

  const mockPrisma = () => ({
    $transaction: async (cb: (tx: unknown) => unknown) => {
      const tx = {
        scene: {
          findUnique: vi.fn().mockResolvedValue(sceneRow),
          update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            sceneUpdateCalls.push(data);
            sceneRow = { ...sceneRow, ...data, version: sceneRow.version + 1 };
            return sceneRow;
          }),
        },
        episode: {
          findUnique: vi.fn().mockResolvedValue(episodeRow),
          update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            episodeUpdateCalls.push(data);
            episodeRow = { ...episodeRow, ...data, version: episodeRow.version + 1 };
            return episodeRow;
          }),
        },
        generationLog: { create: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    },
  });

  return {
    prisma: mockPrisma,
    __reset: reset,
    __sceneCalls: () => sceneUpdateCalls,
    __episodeCalls: () => episodeUpdateCalls,
  };
});

import { updateSceneNarration, updateEpisodeMeta } from './write.js';
import { __reset, __sceneCalls, __episodeCalls } from '../../database/prisma.js';

describe('L14: scene/episode edits with validation and optimistic locking', () => {
  beforeEach(() => {
    __reset();
  });

  describe('updateSceneNarration', () => {
    const validText = 'This is a valid narration text that is long enough for the validator.';

    it('rejects HTML tags', async () => {
      await expect(updateSceneNarration('sc-1', '<script>alert(1)</script>', 2, 'user-1')).rejects.toThrow(
        new AppError('HTML tags are not allowed in narrationText', 400, 'INVALID_INPUT')
      );
    });

    it('rejects text that is too short', async () => {
      await expect(updateSceneNarration('sc-1', 'short', 2, 'user-1')).rejects.toThrow(
        new AppError('narrationText must be at least 10 characters', 400, 'INVALID_INPUT')
      );
    });

    it('rejects text that is too long', async () => {
      await expect(updateSceneNarration('sc-1', 'x'.repeat(2001), 2, 'user-1')).rejects.toThrow(
        new AppError('narrationText must be at most 2000 characters', 400, 'INVALID_INPUT')
      );
    });

    it('throws 403 for a non-owner', async () => {
      await expect(updateSceneNarration('sc-1', validText, 2, 'user-2')).rejects.toThrow(
        new AppError('Forbidden — you do not own this story', 403, 'FORBIDDEN')
      );
    });

    it('throws 409 when the expected version does not match', async () => {
      await expect(updateSceneNarration('sc-1', validText, 99, 'user-1')).rejects.toThrow(
        new AppError('Conflict — the scene was modified by another request. Please refresh and try again.', 409, 'OPTIMISTIC_LOCK_CONFLICT')
      );
    });

    it('increments the version on a successful edit', async () => {
      await updateSceneNarration('sc-1', validText, 2, 'user-1');
      const calls = __sceneCalls();
      expect(calls).toHaveLength(1);
      const update = calls[0] as { narrationText: string; version: { increment: number } };
      expect(update.narrationText).toBe(validText);
      expect(update.version).toEqual({ increment: 1 });
    });
  });

  describe('updateEpisodeMeta', () => {
    it('rejects empty update objects', async () => {
      await expect(updateEpisodeMeta('ep-1', {}, 3, 'user-1')).rejects.toThrow(
        new AppError('At least one field must be provided', 400, 'INVALID_INPUT')
      );
    });

    it('rejects HTML in title', async () => {
      await expect(updateEpisodeMeta('ep-1', { title: '<b>X</b>' }, 3, 'user-1')).rejects.toThrow(
        new AppError('HTML tags are not allowed in title', 400, 'INVALID_INPUT')
      );
    });

    it('rejects a title that is too long', async () => {
      await expect(updateEpisodeMeta('ep-1', { title: 'x'.repeat(201) }, 3, 'user-1')).rejects.toThrow(
        new AppError('title must be at most 200 characters', 400, 'INVALID_INPUT')
      );
    });

    it('throws 403 for a non-owner', async () => {
      await expect(updateEpisodeMeta('ep-1', { title: 'New Title' }, 3, 'user-2')).rejects.toThrow(
        new AppError('Forbidden — you do not own this story', 403, 'FORBIDDEN')
      );
    });

    it('throws 409 when the expected version does not match', async () => {
      await expect(updateEpisodeMeta('ep-1', { title: 'New Title' }, 99, 'user-1')).rejects.toThrow(
        new AppError('Conflict — the episode was modified by another request. Please refresh and try again.', 409, 'OPTIMISTIC_LOCK_CONFLICT')
      );
    });

    it('increments the version on a successful meta update', async () => {
      await updateEpisodeMeta('ep-1', { title: 'New Title', hook: 'New hook.' }, 3, 'user-1');
      const calls = __episodeCalls();
      expect(calls).toHaveLength(1);
      const update = calls[0] as { title: string; hook: string; version: { increment: number } };
      expect(update.title).toBe('New Title');
      expect(update.hook).toBe('New hook.');
      expect(update.version).toEqual({ increment: 1 });
    });
  });
});
