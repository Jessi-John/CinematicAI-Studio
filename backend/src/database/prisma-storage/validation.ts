import { episodesPerStory, scenesPerEpisode, TARGET_EPISODE_SECONDS } from '../../lib/timing.js';

const MIN_PROMPT_LEN = 100;

export class DuplicateStoryError extends Error {
  readonly genre: string;
  readonly seed: string;
  readonly skipDlq = true;
  constructor(genre: string, seed: string) {
    super(`Duplicate story: genre=${genre}, seed=${seed} violates unique constraint`);
    this.name = 'DuplicateStoryError';
    this.genre = genre;
    this.seed = seed;
  }
}

/**
 * LIVE-5: Thrown when a generated story's SEO title is too similar to an
 * existing story's SEO title. Marked skipDlq so the worker treats it as a
 * terminal duplicate rather than a retryable failure.
 */
export class DuplicateSeoTitleError extends Error {
  readonly title: string;
  readonly existingTitle: string;
  readonly skipDlq = true;
  constructor(title: string, existingTitle: string) {
    super(`SEO title too similar to an existing story: "${title}" vs "${existingTitle}"`);
    this.name = 'DuplicateSeoTitleError';
    this.title = title;
    this.existingTitle = existingTitle;
  }
}

/**
 * Thrown by createStory when, at commit time, another completed story already
 * uses the same protagonist name. Closes the concurrent-job race that the
 * in-loop blueprint guard cannot see (two jobs sharing one uniqueness snapshot
 * both inventing the same new name). The job regenerates with a fresh name.
 */
export class ProtagonistNameCollisionError extends Error {
  readonly protagonistName: string;
  constructor(protagonistName: string) {
    super(`Protagonist name "${protagonistName}" already used by a committed story; regenerating`);
    this.name = 'ProtagonistNameCollisionError';
    this.protagonistName = protagonistName;
  }
}

export function validateStoryInvariants(story: { episodes: Array<{ number: number; duration: number; scenes: Array<{ number: number; duration: number; imagePrompt?: { content: string }; videoPrompt?: { content: string }; narration?: { text: string } }> }> }): void {
  if (story.episodes.length !== episodesPerStory) {
    throw new Error(`Story invariant violated: expected ${episodesPerStory} episodes, got ${story.episodes.length}`);
  }
  for (const ep of story.episodes) {
    if (ep.scenes.length !== scenesPerEpisode) {
      throw new Error(`Story invariant violated: episode ${ep.number} has ${ep.scenes.length} scenes, expected ${scenesPerEpisode}`);
    }
    if (ep.duration < TARGET_EPISODE_SECONDS || ep.duration > TARGET_EPISODE_SECONDS + 10) {
      throw new Error(`Story invariant violated: episode ${ep.number} duration ${ep.duration}s outside 50-60s range`);
    }
    for (const sc of ep.scenes) {
      if (!sc.imagePrompt?.content || sc.imagePrompt.content.length < MIN_PROMPT_LEN) {
        throw new Error(`Story invariant violated: episode ${ep.number} scene ${sc.number} imagePrompt too short (${sc.imagePrompt?.content?.length ?? 0} chars)`);
      }
      if (!sc.videoPrompt?.content || sc.videoPrompt.content.length < MIN_PROMPT_LEN) {
        throw new Error(`Story invariant violated: episode ${ep.number} scene ${sc.number} videoPrompt too short (${sc.videoPrompt?.content?.length ?? 0} chars)`);
      }
      if (!sc.narration?.text || sc.narration.text.trim().length < 15) {
        throw new Error(`Story invariant violated: episode ${ep.number} scene ${sc.number} narration too short`);
      }
    }
  }

  const narrationPairs: Array<{ ep: number; scene: number; text: string }> = [];
  for (const ep of story.episodes) {
    for (const sc of ep.scenes) {
      const t = sc.narration?.text || '';
      if (t.length >= 120) narrationPairs.push({ ep: ep.number, scene: sc.number, text: t });
    }
  }
  let dupeCount = 0;
  for (let i = 0; i < narrationPairs.length; i++) {
    for (let j = i + 1; j < narrationPairs.length; j++) {
      const a = narrationPairs[i]!;
      const b = narrationPairs[j]!;
      if (a.ep !== b.ep && a.text === b.text) {
        dupeCount++;
      }
    }
  }
  // Allow up to 10 cross-episode duplicate pairs across 50 scenes (20%).
  // A zero-duplicate threshold is unrealistic for AI-generated content that
  // reuses consistent character names, setting terms, and genre vocabulary.
  // The humanization stage (stage7) deduplicates near-exact matches at >= 0.95
  // Jaccard similarity during the repetition pass, so only residual near-identical
  // pairs that escape that pass are caught here.
  if (dupeCount > 10) {
    throw new Error(`Story invariant violated: ${dupeCount} cross-episode duplicate narration pairs detected`);
  }

  const allWords: string[] = [];
  for (const ep of story.episodes) {
    for (const sc of ep.scenes) {
      const t = sc.narration?.text || '';
      if (t.length >= 120) {
        allWords.push(...t.toLowerCase().split(/\s+/));
      }
    }
  }
  if (allWords.length > 0) {
    const triGramCounts = new Map<string, number>();
    for (let i = 0; i < allWords.length - 2; i++) {
      const phrase = allWords.slice(i, i + 3).join(' ');
      triGramCounts.set(phrase, (triGramCounts.get(phrase) || 0) + 1);
    }
    let highlyRepeated = 0;
    const epCount = story.episodes.length;
    for (const count of triGramCounts.values()) {
      if (count > epCount * 3) highlyRepeated += 1;
    }
    if (highlyRepeated > 8) {
      throw new Error(`Story invariant violated: ${highlyRepeated} trigrams appear more than ${epCount * 3} times — systemic repetition detected`);
    }
  }
}

export function validateEmbedding(embedding: number[] | undefined | null): number[] {
  // Missing/empty embeddings are valid: the column defaults to '{}' and the
  // partial HNSW index (WHERE array_length = 1024) excludes such rows, so a
  // story persists fine and the background-embedding worker backfills the
  // vector later. Returning null here was the persistence-killing bug —
  // Prisma rejects null for non-nullable list fields, and the resulting
  // unchecked-input fallback error ("Unknown argument `user`") masked the
  // real cause while fully generated stories were lost.
  if (!embedding || embedding.length === 0) return [];
  if (embedding.length !== 1024) {
    throw new Error(`Invalid embedding dimension is ${embedding.length}, expected 1024`);
  }
  // L17: reject NaN/Infinity components — they would persist into the float8
  // array and poison HNSW vector math (cosine ops on NaN poison index scans).
  if (!embedding.every(Number.isFinite)) {
    throw new Error('Invalid embedding: all components must be finite numbers');
  }
  return embedding;
}
