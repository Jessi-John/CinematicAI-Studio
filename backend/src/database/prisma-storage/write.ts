import { AppError } from '../../middleware/error.js';
import crypto from 'node:crypto';
import { logger } from '../../services/logger.js';
import { prisma } from '../prisma.js';
import { getSharedRedis } from '../../lib/shared-redis.js';
import { convertStory } from './converters.js';
import { buildStoryCreateData, isStoryInput, type StoryInput } from './builder.js';
import { DuplicateStoryError, ProtagonistNameCollisionError } from './validation.js';
import { checkSeoTitleDuplicate } from '../../services/similarity.js';

import type { Prisma } from '@prisma/client';

const HTML_TAG_REGEX = /<[a-z][\s\S]*>/i;

const LENGTH_LIMITS = {
  narrationText: { min: 10, max: 2000 },
  title: { min: 1, max: 200 },
  hook: { min: 0, max: 500 },
  synopsis: { min: 0, max: 1000 },
  cliffhanger: { min: 0, max: 500 },
} as const;

type EditableField = keyof typeof LENGTH_LIMITS;

function hasHtmlTags(value: string): boolean {
  return HTML_TAG_REGEX.test(value);
}

function validateTextField(value: string, field: EditableField): void {
  if (typeof value !== 'string') {
    throw new AppError(`${field} must be a string`, 400, 'INVALID_INPUT');
  }
  const limits = LENGTH_LIMITS[field];
  if (value.length < limits.min) {
    throw new AppError(`${field} must be at least ${limits.min} characters`, 400, 'INVALID_INPUT');
  }
  if (value.length > limits.max) {
    throw new AppError(`${field} must be at most ${limits.max} characters`, 400, 'INVALID_INPUT');
  }
  if (hasHtmlTags(value)) {
    throw new AppError(`HTML tags are not allowed in ${field}`, 400, 'INVALID_INPUT');
  }
}

function validateVersion(version: unknown): asserts version is number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new AppError('expectedVersion must be a non-negative integer', 400, 'INVALID_INPUT');
  }
}

const FULL_INCLUDE: Prisma.StoryInclude = {
  episodes: {
    include: {
      scenes: {
        orderBy: { number: 'asc' },
        take: 100,
      },
    },
    take: 20,
  },
  characters: true,
  environments: true,
  youtubeSeo: true,
};

export async function createStory(
  story: StoryInput,
  opts: { protagonistName?: string } = {}
): Promise<ReturnType<typeof convertStory>> {
  // LIVE-5: guard against cross-story SEO title duplication before any DB work.
  if (story.youtubeSeo?.title) {
    await checkSeoTitleDuplicate(story.youtubeSeo.title, undefined, story.userId);
  }

  const data = buildStoryCreateData(story);

  // Race-free protagonist-name uniqueness: the check and the insert run in ONE
  // Serializable transaction, so two concurrent jobs that independently invent
  // the same new protagonist name cannot both commit it — the second sees the
  // first's committed character (or is aborted by P2034 and retried) and rejects
  // the name, forcing regeneration with a fresh one.
  const MAX_TX_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
    try {
      const result = await prisma().$transaction(async (tx) => {
        if (opts.protagonistName) {
          const clash = await tx.character.findFirst({
            where: {
              name: { equals: opts.protagonistName, mode: 'insensitive' },
              story: { status: 'complete' },
              ...(story.id ? { NOT: { storyId: story.id } } : {}),
            },
            select: { storyId: true },
          });
          if (clash) throw new ProtagonistNameCollisionError(opts.protagonistName);
        }
        return tx.story.create({ data, include: FULL_INCLUDE });
      }, { isolationLevel: 'Serializable' });
      return convertStory(result);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        // M6: P2002 fires for EVERY unique constraint (id PK, episode/scene
        // numbers, youtube_seo storyId) — not just (genre, deduplicationKey).
        // Only translate to DuplicateStoryError when the violated target is
        // the dedup index; otherwise surface the real error so genuine data
        // bugs aren't misrouted into duplicate-handling (409/DLQ skip).
        const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
        const targetStr = Array.isArray(target) ? target.join(',') : String(target ?? '');
        if (targetStr.includes('deduplicationKey') || targetStr.includes('genre')) {
          throw new DuplicateStoryError(story.genre, story.seed ?? '');
        }
        throw err;
      }
      if (err instanceof ProtagonistNameCollisionError) throw err;
      // P2034 = serialization_failure: a concurrent transaction conflicted.
      // Retry the whole check+insert so the re-check observes the committed row.
      if (code === 'P2034' && attempt < MAX_TX_RETRIES - 1) {
        lastError = err;
        await new Promise<void>((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function updateSceneNarration(
  sceneId: string,
  narrationText: string,
  expectedVersion: number,
  userId: string
): Promise<void> {
  validateTextField(narrationText, 'narrationText');
  validateVersion(expectedVersion);

  await prisma().$transaction(async (tx) => {
    const scene = await tx.scene.findUnique({
      where: { id: sceneId },
      include: {
        episode: {
          include: {
            story: { select: { id: true, userId: true } },
          },
        },
      },
    });

    if (!scene || !scene.episode || !scene.episode.story) {
      throw new AppError('Scene not found', 404, 'NOT_FOUND');
    }

    if (scene.episode.story.userId !== userId) {
      throw new AppError('Forbidden — you do not own this story', 403, 'FORBIDDEN');
    }

    if (scene.version !== expectedVersion) {
      throw new AppError(
        'Conflict — the scene was modified by another request. Please refresh and try again.',
        409,
        'OPTIMISTIC_LOCK_CONFLICT'
      );
    }

    await tx.scene.update({
      where: { id: sceneId },
      data: {
        narrationText,
        version: { increment: 1 },
      },
    });

    await tx.generationLog.create({
      data: {
        action: 'scene_edit',
        details: { narrationText, previousText: scene.narrationText },
        storyId: scene.episode.story.id,
        episodeId: scene.episodeId,
        sceneId,
      },
    });
  });
}

export async function updateEpisodeMeta(
  episodeId: string,
  updates: { title?: string; hook?: string; synopsis?: string; cliffhanger?: string },
  expectedVersion: number,
  userId: string
): Promise<void> {
  validateVersion(expectedVersion);

  const fields = Object.keys(updates) as EditableField[];
  if (fields.length === 0) {
    throw new AppError('At least one field must be provided', 400, 'INVALID_INPUT');
  }
  for (const field of fields) {
    if (field === 'narrationText') {
      throw new AppError('narrationText cannot be edited via episode meta', 400, 'INVALID_INPUT');
    }
    const value = updates[field];
    if (value !== undefined) {
      validateTextField(value, field);
    }
  }

  await prisma().$transaction(async (tx) => {
    const episode = await tx.episode.findUnique({
      where: { id: episodeId },
      include: {
        story: { select: { id: true, userId: true } },
      },
    });

    if (!episode || !episode.story) {
      throw new AppError('Episode not found', 404, 'NOT_FOUND');
    }

    if (episode.story.userId !== userId) {
      throw new AppError('Forbidden — you do not own this story', 403, 'FORBIDDEN');
    }

    if (episode.version !== expectedVersion) {
      throw new AppError(
        'Conflict — the episode was modified by another request. Please refresh and try again.',
        409,
        'OPTIMISTIC_LOCK_CONFLICT'
      );
    }

    await tx.episode.update({
      where: { id: episodeId },
      data: {
        ...updates,
        version: { increment: 1 },
      },
    });

    await tx.generationLog.create({
      data: {
        action: 'episode_edit',
        details: updates,
        storyId: episode.story.id,
        episodeId,
      },
    });
  });
}

export async function updateStory(id: string, updates: { title?: string; status?: string; theme?: string | null; seed?: string | null; seedStoryId?: string }) {
  const data: Record<string, unknown> = {};
  if (updates.title !== undefined)
    data.title = updates.title;
  if (updates.status !== undefined)
    data.status = updates.status;
  if (updates.theme !== undefined)
    data.theme = updates.theme || null;
  if (updates.seed !== undefined) {
    data.seed = updates.seed || null;
    // L8: keep the dedup key in sync — the partial unique index guards the
    // OLD key otherwise (latent: no route currently passes seed).
    data.deduplicationKey = updates.seed || null;
  }
  if (updates.seedStoryId !== undefined) {
    data.seedStory = updates.seedStoryId
      ? { connect: { id: updates.seedStoryId } }
      : { disconnect: true };
  }
  try {
    const result = await prisma().story.update({
      where: { id },
      data,
      include: FULL_INCLUDE,
    });
    return convertStory(result);
  }
  catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025')
      return null;
    throw err;
  }
}

function computeEmbeddingCacheKey(title: string, theme: string | null | undefined, seed: string | null | undefined, synopsis0: string, synopsis1: string) {
  const conceptText = [title, theme || '', seed || '', synopsis0 || '', synopsis1 || '']
    .filter(Boolean)
    .join(' | ');
  const hash = crypto.createHash('sha256').update(conceptText.trim()).digest('hex');
  return `embedding:v1:${hash}`;
}

export async function deleteStory(id: string) {
  // L12: Read once (inside the transaction), delete, then evict the embedding
  // cache AFTER commit — previously the unawaited Redis eviction fired inside
  // the transaction (evicting even if the tx later aborted) and the story was
  // read twice.
  try {
    const cacheKey = await prisma().$transaction(async (tx) => {
      const txStory = await tx.story.findUnique({
        where: { id },
        select: {
          title: true, theme: true, seed: true,
          episodes: { orderBy: { number: 'asc' }, take: 2, select: { synopsis: true } },
        },
      });
      if (!txStory) return null;
      await tx.generationLog.deleteMany({ where: { storyId: id } });
      await tx.story.delete({ where: { id } });
      return computeEmbeddingCacheKey(
        txStory.title, txStory.theme, txStory.seed,
        txStory.episodes[0]?.synopsis ?? '', txStory.episodes[1]?.synopsis ?? ''
      );
    });
    if (cacheKey === null) return false;
    await getSharedRedis()
      .del(cacheKey)
      .catch((err: Error) => logger.warn({ err, cacheKey }, 'Redis embedding cache cleanup failed'));
    return true;
  }
  catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025')
      return false;
    throw err;
  }
}

export async function replaceStoryAtomically(
  oldStoryId: string,
  newStory: unknown,
  actorUserId?: string,
): Promise<ReturnType<typeof convertStory>> {
  // MEDIUM #39: Runtime validation instead of unsafe `as any`.
  if (!isStoryInput(newStory)) {
    throw new Error('Invalid story payload: required fields missing');
  }
  const story = newStory;

  // LIVE-5: the replacement story may share the same title as the old one,
  // so exclude oldStoryId from the cross-story SEO title similarity check.
  if (story.youtubeSeo?.title) {
    await checkSeoTitleDuplicate(story.youtubeSeo.title, oldStoryId, story.userId);
  }

  const result = await prisma().$transaction(async (tx) => {
    // LOW #62: Defense-in-depth ownership assertion inside the same
    // transaction that mutates the story. The route already checks, but
    // asserting here prevents privilege escalation if this storage function is
    // ever reused by an admin endpoint or batch job.
    if (actorUserId) {
      const owner = await tx.story.findUnique({
        where: { id: oldStoryId },
        select: { userId: true },
      });
      if (!owner || owner.userId !== actorUserId) {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      }
    }
    // HIGH #21: Preserve the audit trail when a story is regenerated.
    //
    // C1 FIX (FK ordering): generation_logs.storyId is an IMMEDIATE foreign key
    // (ON DELETE SET NULL). Re-pointing the logs at the replacement story
    // therefore requires the new row to already exist — but creating the new
    // row BEFORE deleting the old one trips the (genre, deduplicationKey)
    // partial-unique index, because regeneration reuses the same genre+seed.
    // Both constraints are satisfied with a capture → delete → create →
    // re-point order:
    //   1. Capture the old story's generation-log ids (before the delete
    //      nulls their storyId via ON DELETE SET NULL).
    //   2. Delete the old story — frees the unique slot so the create below
    //      cannot P2002, and does NOT destroy the logs (SET NULL only).
    //   3. Create the replacement story — newStoryId now exists, so it is a
    //      valid FK target for the logs.
    //   4. Re-point the captured logs (by primary key) at the new story.
    // The previous order moved the logs FIRST (before the new row existed),
    // which the immediate FK rejected with P2003 on every regeneration.
    // L13: isStoryInput guarantees story.id is a string — the `?? oldStoryId`
    // fallback was unreachable.
    const newStoryId: string = story.id;
    const logIds = (
      await tx.generationLog.findMany({
        where: { storyId: oldStoryId },
        select: { id: true },
      })
    ).map((log) => log.id);

    try {
      await tx.story.delete({ where: { id: oldStoryId } });
    } catch (err: unknown) {
      const storyErr = err as { code?: string };
      if (storyErr.code !== 'P2025') throw err;
    }

    const createData = buildStoryCreateData(story);
    createData.id = newStoryId;

    let created;
    try {
      created = await tx.story.create({
        data: createData,
        include: FULL_INCLUDE,
      });
    } catch (err: unknown) {
      const priErr = err as { code?: string };
      if (priErr.code === 'P2002') {
        throw new DuplicateStoryError(story.genre, story.seed ?? '');
      }
      throw err;
    }

    if (logIds.length > 0) {
      await tx.generationLog.updateMany({
        where: { id: { in: logIds } },
        data: { storyId: newStoryId },
      });
    }

    return created;
  });
  return convertStory(result);
}

export async function cleanupOrphanedGenerationLogs(daysOld = 30) {
  // L15: batch the delete — a large orphan backlog in one statement becomes a
  // long-running DELETE that locks generation_logs.
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const BATCH = 1000;
  let total = 0;
  for (;;) {
    const batch = await prisma().generationLog.findMany({
      where: { storyId: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (batch.length === 0) break;
    const result = await prisma().generationLog.deleteMany({
      where: { id: { in: batch.map((b) => b.id) } },
    });
    total += result.count;
    if (batch.length < BATCH) break;
  }
  return total;
}
