/**
 * Similarity detection service for story deduplication.
 *
 * Provides both semantic similarity (via pgvector HNSW index) and lexical
 * similarity (via PostgreSQL pg_trgm extension). Used by the generation
 * pipeline to detect duplicate concepts before persisting new stories.
 *
 * Architecture:
 *   - Semantic similarity: computes embedding via Mistral, queries pgvector
 *   - Lexical similarity: uses PostgreSQL similarity() function with pg_trgm
 *   - Fallback chain: semantic → lexical fallback if embedding generation fails
 *   - Circuit breakers: all queries use LIMIT to prevent unbounded result sets
 */

import { prisma } from '../database/prisma.js';
import { Prisma } from '@prisma/client';
import { generateEmbedding } from '../lib/embeddings.js';
import { runWithAIPipelineContext } from '../lib/ai-client.js';
import { logger } from './logger.js';
import { DuplicateSeoTitleError } from '../database/prisma-storage/validation.js';

// ---------- Thresholds ----------

export const SEMANTIC_DUP_THRESHOLD = 0.88;
export const LEXICAL_HARD_BLOCK = 0.9; // legacy lexical hard-block (used in generation route)
export const LEXICAL_NEAR_DUPE = 0.72;

// ---------- Types ----------

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
  via: 'lexical' | 'semantic';
}

export interface SimilarityCheckInput {
  genre?: string; // legacy single-genre field, still supported
  genres?: string[]; // multi-genre form, takes precedence when both are present
  seed?: string;
  theme: string;
  title: string;
  /** Scope deduplication to a single user's stories. When omitted, the
   *  legacy global-corpus behavior is preserved for callers that do not
   *  yet have a user context (should be removed once all callers pass it). */
  userId?: string;
}

// ---------- Text normalization ----------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into',
  'story', 'episode', 'journey', 'style', 'anime', 'short',
]);

/**
 * Tokenize and normalize text for similarity comparison.
 * Lowercases, removes punctuation, filters stop words and short tokens.
 */
export function normalizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Extract and normalise the genre set from a similarity input. The legacy
 * `input.genre` (singular) and the new `input.genres` (plural) both feed
 * dedup — we de-duplicate and ignore empty values so callers can pass
 * either shape (or both) without coordinating. Fix #33.
 */
function extractGenres(input: SimilarityCheckInput): string[] {
  return Array.from(
    new Set(
      [input.genres ?? [], input.genre ? [input.genre] : []]
        .flat()
        .map((g) => String(g).trim())
        .filter(Boolean)
    )
  );
}

// ---------- Lexical similarity ----------

/**
 * Compute Jaccard similarity between two texts using normalized word sets.
 * Returns a value in [0, 1] where 1 = identical word sets.
 */
export function calcTextSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeForSimilarity(a));
  const wb = new Set(normalizeForSimilarity(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let intersect = 0;
  for (const w of wa) if (wb.has(w)) intersect += 1;
  const union = wa.size + wb.size - intersect;
  return union > 0 ? intersect / union : 0;
}

// ---------- Core similarity checks ----------

/**
 * Compute similarity of candidate narration against the broader story corpus
 * using pgvector HNSW index. Falls back to lexical-only check if embedding
 * generation fails.
 */
export async function checkNewContentSimilarity(
  genre: string,
  candidateNarration: string,
  excludeStoryId: string,
  contextJobId?: string,
  userId?: string
): Promise<number> {
  const resolvedJobId = contextJobId ?? 'similarity-check-unknown';
  const candidateEmbedding = await runWithAIPipelineContext(
    resolvedJobId,
    null,
    () => generateEmbedding(candidateNarration, resolvedJobId)
  );
  if (!candidateEmbedding || candidateEmbedding.length === 0) {
    return checkNewContentSimilarityLexical(genre, candidateNarration, excludeStoryId, userId);
  }

  // pgvector: find closest story by cosine distance (<=> operator)
  // Returns score = 1 - cosine_distance (so higher = more similar)
  //
  // SECURITY/FIX: JavaScript number[] (Float[]) cannot be passed directly as a
  // Prisma parameter with ::vector cast — Prisma serializes it as BigDecimal[]
  // which PostgreSQL cannot cast to vector. Convert to pgvector string format
  // '[val1,val2,...]' before passing as parameter.
  const vectorString = '[' + candidateEmbedding.map((v) => v.toFixed(10)).join(',') + ']';
  const userFilter = userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty;

  const result = await prisma().$queryRaw<Array<{ score: number }>>`
    SELECT 1 - (("embedding"::vector) <=> ${vectorString}::vector) AS score
    FROM "stories"
    WHERE genre = ${genre}
      AND id != ${excludeStoryId}
      AND "embedding" IS NOT NULL
      AND array_length("embedding", 1) IS NOT NULL
      ${userFilter}
    ORDER BY ("embedding"::vector) <=> ${vectorString}::vector
    LIMIT 1
  `;

  return result.length > 0 ? Number(result[0]!.score) : 0;
}

/**
 * Lexical fallback when embedding generation fails.
 * Compares candidate narration against up to 100 stories in the same genre
 * using Jaccard word similarity (calcTextSimilarity).
 */
export async function checkNewContentSimilarityLexical(
  genre: string,
  candidateNarration: string,
  excludeStoryId: string,
  userId?: string
): Promise<number> {
  const where: Record<string, unknown> = { genre, id: { not: excludeStoryId } };
  if (userId) {
    where['userId'] = userId;
  }
  const candidates = await prisma().story.findMany({
    where,
    select: { id: true, title: true, seed: true, theme: true },
    // L3: order for determinism — an arbitrary 100-row subset otherwise
    // misses duplicates nondeterministically beyond 100 stories per genre.
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  let maxSim = 0;
  for (const story of candidates) {
    const otherText = [story.seed, story.theme, story.title].filter(Boolean).join(' ');
    const lexScore = calcTextSimilarity(candidateNarration, otherText);
    maxSim = Math.max(maxSim, lexScore);
  }
  return maxSim;
}

// ---------- Duplicate concept detection ----------

/**
 * Find a duplicate story concept in the corpus.
 *
 * Fix #33: Accepts multiple genres. The previous version only filtered by
 * a single `input.genre` — but the create UI lets users select up to 2
 * genres and the worker blends motifs from each. A story tagged as
 * `["fantasy", "romance"]` would be deduplicated only against the first
 * genre, missing duplicates in the romance corpus. We now use
 * `genre = ANY(...)` so the scan covers every selected genre.
 *
 * Checks in order:
 *   1. Exact seed match (fast-path, O(1) lookup) — any of the input genres
 *   2. Semantic similarity via pgvector (HNSW index query) — any of the input genres
 *   3. Lexical near-duplicate via pg_trgm similarity() (full-text scan, LIMIT 100)
 *
 * Returns null if no duplicate above threshold is found.
 */
export async function findDuplicateConcept(
  input: SimilarityCheckInput,
  contextJobId?: string
): Promise<DuplicateMatch | null> {
  const genres = extractGenres(input);
  if (genres.length === 0) return null;

  const resolvedJobId = contextJobId ?? 'duplicate-concept-unknown';

  // Lexical fast-path: exact seed match — covers every selected genre.
  // L3: case-insensitive both sides — a case-differing resubmission of the
  // same seed was previously allowed through.
  if (input.seed) {
    const exactWhere: Record<string, unknown> = { genre: { in: genres }, seed: { equals: input.seed, mode: 'insensitive' } };
    if (input.userId) {
      exactWhere['userId'] = input.userId;
    }
    const exactMatch = await prisma().story.findFirst({
      where: exactWhere,
      select: { id: true, title: true },
    });
    if (exactMatch) return { id: exactMatch.id, title: exactMatch.title, score: 1, via: 'lexical' };
  }

  // Semantic dedupe via pgvector HNSW index — covers every selected genre
  const concept = [input.seed, input.theme, input.title].filter(Boolean).join(' ');
  const candidateEmbedding = await runWithAIPipelineContext(
    resolvedJobId,
    null,
    () => generateEmbedding(concept, resolvedJobId)
  );
  if (candidateEmbedding && candidateEmbedding.length > 0) {
    // SECURITY/FIX: Convert number[] to pgvector string format to avoid BigDecimal serialization error
  // L3: non-finite components (NaN/Infinity) survive toFixed(10) into an
  // invalid vector literal → raw PG error instead of the lexical fallback.
  if (!candidateEmbedding.every(Number.isFinite)) {
    logger.warn('Embedding contains non-finite components — falling back to lexical duplicate check');
    return findDuplicateLexical(input);
  }
  const vectorString = '[' + candidateEmbedding.map((v) => v.toFixed(10)).join(',') + ']';
    const userFilter = input.userId ? Prisma.sql`AND "userId" = ${input.userId}` : Prisma.empty;

    const semanticMatch = await prisma().$queryRaw<Array<{
      id: string;
      title: string;
      score: number;
    }>>`
      SELECT id, title, 1 - (("embedding"::vector) <=> ${vectorString}::vector) AS score
      FROM "stories"
      WHERE genre = ANY(${genres}::text[])
        AND "embedding" IS NOT NULL
        AND array_length("embedding", 1) IS NOT NULL
        AND 1 - (("embedding"::vector) <=> ${vectorString}::vector) > ${SEMANTIC_DUP_THRESHOLD}
        ${userFilter}
      ORDER BY ("embedding"::vector) <=> ${vectorString}::vector
      LIMIT 1
    `;
    if (semanticMatch.length > 0) {
      const first = semanticMatch[0];
      if (!first) return null;
      return {
        id: first.id,
        title: first.title,
        score: Number(first.score),
        via: 'semantic' as const,
      };
    }
  }

  // Lexical near-duplicate sweep — covers every selected genre
  return findDuplicateLexical(input);
}

/**
 * Lexical near-duplicate detection using PostgreSQL pg_trgm similarity().
 *
 * Fix #33: Accepts the same multi-genre input as findDuplicateConcept.
 * `genre = ANY(${genres}::text[])` scans every selected genre in a single
 * query (the previous `genre = ${input.genre}` only filtered by the first).
 *
 * PERF-004: Pushes similarity scoring to PostgreSQL via $queryRaw with
 * similarity() and LIMIT 100, instead of loading 1000 rows into JS.
 * Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;
 */
export async function findDuplicateLexical(
  input: SimilarityCheckInput
): Promise<DuplicateMatch | null> {
  const genres = extractGenres(input);
  if (genres.length === 0) return null;

  const concept = [input.seed, input.theme, input.title].filter(Boolean).join(' ');

  // L17: Exclude the story being edited from the duplicate check. Previously
  // a story could match itself as a "duplicate" when called for edits.
  const excludeStoryId = (input as SimilarityCheckInput & { excludeStoryId?: string }).excludeStoryId;
  const userFilter = input.userId ? Prisma.sql`AND "userId" = ${input.userId}` : Prisma.empty;
  const existing = await prisma().$queryRaw<Array<{ id: string; title: string; sim: number }>>`
    SELECT id, title,
      similarity(title || ' ' || COALESCE(seed, '') || ' ' || COALESCE(theme, ''), ${concept}) AS sim
    FROM "stories"
    WHERE genre = ANY(${genres}::text[])
      ${excludeStoryId ? Prisma.sql`AND id != ${excludeStoryId}` : Prisma.empty}
      ${userFilter}
    ORDER BY sim DESC
    LIMIT 100
  `;

  if (existing.length === 0) return null;
  const best = existing[0]!;
  if (best.sim < LEXICAL_NEAR_DUPE) return null;
  return { id: best.id, title: best.title, score: best.sim, via: 'lexical' };
}

export const SEO_TITLE_DUP_THRESHOLD = 0.85;

/**
 * LIVE-5: Check whether the proposed YouTube SEO title is too similar to an
 * existing story's SEO title. Uses PostgreSQL pg_trgm similarity() for a
 * language-agnostic, DB-indexed lexical check.
 *
 * @throws DuplicateSeoTitleError when a similarity above the threshold is found.
 */
export async function checkSeoTitleDuplicate(
  title: string,
  excludeStoryId?: string,
  userId?: string
): Promise<void> {
  if (!title || title.trim().length === 0) return;

  const userFilter = userId ? Prisma.sql`AND s."userId" = ${userId}` : Prisma.empty;
  const excludeFilter = excludeStoryId ? Prisma.sql`AND s.id != ${excludeStoryId}` : Prisma.empty;

  const result = await prisma().$queryRaw<Array<{ title: string; sim: number }>>`
    SELECT ys.title, similarity(ys.title, ${title}) AS sim
    FROM "youtube_seo" ys
    JOIN "stories" s ON s.id = ys."storyId"
    WHERE similarity(ys.title, ${title}) > ${SEO_TITLE_DUP_THRESHOLD}
      ${excludeFilter}
      ${userFilter}
    ORDER BY sim DESC
    LIMIT 1
  `;

  if (result.length > 0 && result[0]) {
    throw new DuplicateSeoTitleError(title, result[0].title);
  }
}

// ---------- Re-export for convenience ----------
// NOTE: LEXICAL_HARD_BLOCK is NOT re-exported here — it is only used internally
// or in generation.ts which imports it directly. This avoids confusion about
// which thresholds are the canonical source of truth.
