import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';

export type GenerationAction =
  | 'story_planning'
  | 'episode_meta'
  | 'episode_scene'
  | 'character_bible'
  | 'youtube_seo'
  | 'retry'
  | 'fallback'
  | 'validation_failed'
  | 'regeneration'
  | 'scene_regeneration'
  | 'story_edit';

export interface GenerationLogEntry {
  action: GenerationAction;
  details: Record<string, unknown>;
  storyId?: string;
  episodeId?: string;
  sceneId?: string;
}

export interface RegenerationDetail {
  type: 'episode' | 'scene';
  episodeNumber: number;
  sceneNumber?: number;
  oldValue: string;
  newValue: string;
  reason: string;
  timestamp: string;
}

// ---------- Helpers ----------

function asRecord(json: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return {};
}

function strOr(val: unknown, def: string): string {
  return typeof val === 'string' ? val : def;
}

function numOr(val: unknown, def: number): number {
  return typeof val === 'number' ? val : def;
}

// ---------- Logging ----------

export async function logGeneration(entry: GenerationLogEntry): Promise<void> {
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // REL-032: episodeId is a FK to Episode.id. Callers sometimes pass episode
      // numbers ("1", "2") instead of DB record IDs, causing "Foreign key constraint
      // violated on generation_logs_episodeId_fkey". If episodeId is all digits,
      // it's an episode number — store it in details and set episodeId to null.
      let safeEpisodeId = entry.episodeId || null;
      if (safeEpisodeId !== null && /^\d+$/.test(safeEpisodeId)) {
        entry.details.episodeNumber = safeEpisodeId;
        safeEpisodeId = null;
      }

      await prisma().generationLog.create({
        data: {
          action: entry.action,
          details: entry.details as Prisma.InputJsonValue,
          storyId: entry.storyId || null,
          episodeId: safeEpisodeId,
          sceneId: entry.sceneId || null,
        },
      });
      return;
    } catch {
      if (attempt >= maxRetries - 1) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt + 1)));
    }
  }
}

export async function logRetry(
  stage: string,
  attempt: number,
  maxRetries: number,
  error: string,
  storyId?: string,
  episodeId?: string
): Promise<void> {
  await logGeneration({
    action: 'retry',
    details: { stage, attempt, maxRetries, error },
    ...(storyId !== undefined ? { storyId } : {}),
    ...(episodeId !== undefined ? { episodeId } : {}),
  });
}

export async function logFallback(
  stage: string,
  reason: string,
  fallbackUsed: string,
  storyId?: string,
  episodeId?: string
): Promise<void> {
  await logGeneration({
    action: 'fallback',
    details: { stage, reason, fallbackUsed },
    ...(storyId !== undefined ? { storyId } : {}),
    ...(episodeId !== undefined ? { episodeId } : {}),
  });
}

export async function logStageComplete(
  action: GenerationAction,
  metadata: Record<string, unknown>,
  storyId?: string,
  episodeId?: string,
  sceneId?: string
): Promise<void> {
  await logGeneration({
    action,
    details: { ...metadata, success: true },
    ...(storyId !== undefined ? { storyId } : {}),
    ...(episodeId !== undefined ? { episodeId } : {}),
    ...(sceneId !== undefined ? { sceneId } : {}),
  });
}

export async function logRegeneration(entry: {
  type: 'episode' | 'scene';
  storyId: string;
  episodeId: string;
  episodeNumber: number;
  sceneNumber?: number;
  oldValue: string;
  newValue: string;
  reason: string;
}): Promise<void> {
  await logGeneration({
    action: entry.type === 'scene' ? 'scene_regeneration' : 'regeneration',
    details: {
      type: entry.type,
      episodeNumber: entry.episodeNumber,
      sceneNumber: entry.sceneNumber,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      reason: entry.reason,
      timestamp: new Date().toISOString(),
    },
    storyId: entry.storyId,
    episodeId: entry.episodeId,
  });
}

/**
 * Log a manual story field edit for audit trail.
 */
export async function logStoryEdit(entry: {
  storyId: string;
  field: string;
  oldValue: string;
  newValue: string;
}): Promise<void> {
  await logGeneration({
    action: 'story_edit',
    details: {
      field: entry.field,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      editedAt: new Date().toISOString(),
    },
    storyId: entry.storyId,
  });
}

// ---------- Queries ----------

export async function getRegenerationHistory(
  storyId: string,
  limit = 50,
  offset = 0
): Promise<RegenerationDetail[]> {
  const logs = await prisma().generationLog.findMany({
    where: {
      storyId,
      action: { in: ['regeneration', 'scene_regeneration'] },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    skip: offset,
  });

  return logs.map((log) => {
    const d = asRecord(log.details);
    return {
      type: log.action === 'scene_regeneration' ? 'scene' : 'episode',
      episodeNumber: numOr(d.episodeNumber, 0),
      sceneNumber: numOr(d.sceneNumber, log.action === 'scene_regeneration' ? 0 : NaN),
      oldValue: strOr(d.oldValue, ''),
      newValue: strOr(d.newValue, ''),
      reason: strOr(d.reason, ''),
      timestamp: log.createdAt.toISOString(),
    };
  });
}

async function getGenerationLogs(storyId: string) {
  return prisma().generationLog.findMany({
    where: { storyId },
    orderBy: { createdAt: 'asc' },
  });
}

function calculateTextSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (words1.size === 0 || words2.size === 0) return 0;
  let intersection = 0;
  for (const w of words1) if (words2.has(w)) intersection += 1;
  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export async function getSceneSimilarityMatrix(
  storyId: string,
  episodeNumber?: number
): Promise<{
  episodes: { number: number; title: string }[];
  matrix: number[][];
  avgSimilarity: number;
  mostSimilarPair: { ep1: number; ep2: number; score: number } | null;
  uniqueScenes: number;
  similarScenes: number;
  tooSimilarScenes: number;
}> {
  // Fix #9: Filter by `episodeNumber` when provided. The previous version
  // ignored this parameter, so a caller asking for episode 4's similarity
  // matrix got the full story matrix. Now we restrict the Prisma include
  // to a single episode.
  const story = await prisma().story.findUnique({
    where: { id: storyId },
    include: {
      episodes: {
        ...(episodeNumber !== undefined ? { where: { number: episodeNumber } } : {}),
        orderBy: { number: 'asc' },
        include: { scenes: { orderBy: { number: 'asc' } } },
      },
    },
  });

  if (!story) {
    return {
      episodes: [],
      matrix: [],
      avgSimilarity: 0,
      mostSimilarPair: null,
      uniqueScenes: 0,
      similarScenes: 0,
      tooSimilarScenes: 0,
    };
  }

  const episodes = story.episodes.map((ep) => ({ number: ep.number, title: ep.title }));
  const scenes: { ep: number; scene: number; text: string }[] = [];
  for (const ep of story.episodes) {
    for (const scene of ep.scenes) {
      scenes.push({ ep: ep.number, scene: scene.number, text: scene.narrationText });
    }
  }

  const matrix: number[][] = [];
  let totalSim = 0;
  let pairs = 0;
  let mostSimilarScore = 0;
  let mostSimilarPair: { ep1: number; ep2: number; score: number } | null = null;
  let unique = 0;
  let similar = 0;
  let tooSimilar = 0;

  for (let i = 0; i < scenes.length; i++) {
    const row: number[] = [];
    matrix.push(row);
    for (let j = 0; j < scenes.length; j++) {
      if (i === j) row[j] = 1;
      else if (j < i) {
        row[j] = matrix[j]![i]!;
      }
      else {
        const sim = calculateTextSimilarity(scenes[i]!.text, scenes[j]!.text);
        row[j] = sim;
        totalSim += sim;
        pairs += 1;
        // M32: `sim < 1` excluded IDENTICAL duplicates from mostSimilarPair —
        // a cross-scene verbatim duplicate (Jaccard = 1.0) could never be
        // reported. Self-pairs are already excluded structurally (i < j), so
        // the cap only masked real duplicates.
        if (sim > mostSimilarScore) {
          mostSimilarScore = sim;
          mostSimilarPair = { ep1: scenes[i]!.ep, ep2: scenes[j]!.ep, score: sim };
        }
      }
    }
    const others = row.filter((_, idx) => idx !== i);
    const avgWithOthers =
      others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    if (avgWithOthers > 0.7) tooSimilar += 1;
    else if (avgWithOthers > 0.5) similar += 1;
    else unique += 1;
  }

  return {
    episodes,
    matrix,
    avgSimilarity: pairs > 0 ? totalSim / pairs : 0,
    mostSimilarPair,
    uniqueScenes: unique,
    similarScenes: similar,
    tooSimilarScenes: tooSimilar,
  };
}

export async function getSceneConfidenceScores(
  storyId: string,
  episodeNumber?: number
): Promise<{
  storyId: string;
  scenes: Array<{
    episodeNumber: number;
    sceneNumber: number;
    confidence: number;
    wordCount: number;
    retryCount: number;
    similarityToPrevious: number;
    factors: string[];
  }>;
  overallConfidence: number;
}> {
  // Fix #9: Filter by `episodeNumber` when provided. The previous version
  // computed confidence for every scene in the story regardless of the
  // caller's intent. Now we restrict the Prisma include to a single episode.
  const logs = await getGenerationLogs(storyId);
  const story = await prisma().story.findUnique({
    where: { id: storyId },
    include: {
      episodes: {
        ...(episodeNumber !== undefined ? { where: { number: episodeNumber } } : {}),
        orderBy: { number: 'asc' },
        include: { scenes: { orderBy: { number: 'asc' } } },
      },
    },
  });

  if (!story) return { storyId, scenes: [], overallConfidence: 0 };

  const scenes: Array<{
    episodeNumber: number;
    sceneNumber: number;
    confidence: number;
    wordCount: number;
    retryCount: number;
    similarityToPrevious: number;
    factors: string[];
  }> = [];

  let totalConfidence = 0;

  for (const ep of story.episodes) {
    for (let i = 0; i < ep.scenes.length; i++) {
      const scene = ep.scenes[i]!;
      const wordCount = scene.narrationText.split(/\s+/).length;

      const retryCount = logs.filter((log) => {
        if (log.action !== 'retry' || log.createdAt < story.createdAt) return false;
        const stage = strOr(asRecord(log.details).stage, '');
        // M32: `scene_${n}` substring-matched scene_10+ across ALL episodes,
        // so scene 1 of every episode inherited retries from scenes 10-19.
        // Match the exact suffix boundary AND scope to this episode.
        const epQualifier = strOr(asRecord(log.details).episode, '');
        if (epQualifier && epQualifier !== String(ep.number)) return false;
        return new RegExp(`scene_${scene.number}\\b`).test(stage) && !new RegExp(`scene_${scene.number}\\d`).test(stage);
      }).length;

      let similarityToPrevious = 0;
      if (i > 0) {
        similarityToPrevious = calculateTextSimilarity(
          scene.narrationText,
          ep.scenes[i - 1]!.narrationText
        );
      }

      let confidence = 100;
      const factors: string[] = [];

      if (wordCount < 10) {
        confidence -= 30;
        factors.push('very_short');
      } else if (wordCount < 20) {
        confidence -= 15;
        factors.push('short');
      } else if (wordCount > 60) {
        confidence -= 15;
        factors.push('long');
      } else {
        factors.push('good_length');
      }

      if (retryCount > 0) {
        confidence -= retryCount * 10;
        factors.push(`retries:${retryCount}`);
      }

      if (similarityToPrevious > 0.7) {
        confidence -= 20;
        factors.push('repetitive');
      } else if (similarityToPrevious > 0.5) {
        confidence -= 10;
        factors.push('somewhat_similar');
      } else {
        factors.push('unique');
      }

      confidence = Math.max(0, Math.min(100, confidence));
      totalConfidence += confidence;

      scenes.push({
        episodeNumber: ep.number,
        sceneNumber: scene.number,
        confidence,
        wordCount,
        retryCount,
        similarityToPrevious: Math.round(similarityToPrevious * 100) / 100,
        factors,
      });
    }
  }

  return {
    storyId,
    scenes,
    overallConfidence:
      scenes.length > 0 ? Math.round(totalConfidence / scenes.length) : 0,
  };
}

export async function getGenerationStatus(storyId: string): Promise<{
  completedStages: string[];
  failedStages: { stage: string; error: string }[];
  retryCount: number;
  fallbackCount: number;
  canRetry: boolean;
}> {
  const logs = await getGenerationLogs(storyId);
  const completedStages: string[] = [];
  const failedStages: { stage: string; error: string }[] = [];
  let retryCount = 0;
  let fallbackCount = 0;

  for (const log of logs) {
    const details = asRecord(log.details);

    switch (log.action) {
      case 'story_planning':
      case 'episode_meta':
      case 'episode_scene':
      case 'character_bible':
      case 'youtube_seo':
      case 'regeneration':
        if (details.success) {
          const epNum = numOr(details.episodeNumber, 0);
          // M32: `${action}_` (not `regeneration_`) when epNum is 0, and
          // dedupe completed stages so a retried stage isn't listed twice.
          const stageName = `${log.action}_${epNum > 0 ? epNum : ''}`.replace(/_$/, '');
          if (!completedStages.includes(stageName)) completedStages.push(stageName);
          // M32: a failed stage that later succeeded must clear canRetry.
          const failIdx = failedStages.findIndex((f) => f.stage === log.action);
          if (failIdx >= 0) failedStages.splice(failIdx, 1);
        } else {
          if (!failedStages.some((f) => f.stage === log.action)) {
            failedStages.push({ stage: log.action, error: strOr(details.error, 'Unknown error') });
          }
        }
        break;
      case 'retry':
        retryCount += 1;
        break;
      case 'fallback':
        fallbackCount += 1;
        break;
    }
  }

  return {
    completedStages,
    failedStages,
    retryCount,
    fallbackCount,
    canRetry: failedStages.length > 0,
  };
}
