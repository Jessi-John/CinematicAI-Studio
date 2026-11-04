// Quality Penalty Engine — deterministic heuristics that detect OBJECTIVE
// defects ONLY. Subjective writing quality (hook strength, pacing, character
// voice, emotional engagement) is evaluated by the LLM judge in
// quality-judge.ts. This module returns penalty deductions for things the
// LLM cannot miss but the pipeline should still catch: missing content,
// structural violations, repetition, continuity errors.
//
// The LLM judge score is the primary quality signal. Penalties from this
// module are subtracted from the LLM score to produce the final score.
// This replaces the previous 50/50 blend where heuristics tried to score
// subjective dimensions — they can't, and averaging them with real
// semantic evaluation produced misleading results.

export interface QualityPenalties {
  totalPenalty: number;
  repetitionPenalty: number;
  structurePenalty: number;
  continuityPenalty: number;
  issues: string[];
}

export interface QualityInput {
  episodes?: Array<{
    hook?: string;
    cliffhanger?: string;
    scenes?: Array<{ narration?: string }>;
  }>;
}

export function calculateQualityPenalties(story: QualityInput): QualityPenalties {
  const repetitionPenalty = detectRepetition(story);
  const structurePenalty = detectStructuralIssues(story);
  const continuityPenalty = detectContinuityIssues(story);

  const issues: string[] = [];
  if (repetitionPenalty > 0) issues.push(`Repetitive content detected (-${repetitionPenalty})`);
  if (structurePenalty > 0) issues.push(`Structural issues detected (-${structurePenalty})`);
  if (continuityPenalty > 0) issues.push(`Continuity issues detected (-${continuityPenalty})`);

  return {
    totalPenalty: repetitionPenalty + structurePenalty + continuityPenalty,
    repetitionPenalty,
    structurePenalty,
    continuityPenalty,
    issues,
  };
}

/** Penalize repeated 3-grams across the story (objective: same phrase used
 *  too many times = broken generation). Pure vocabulary overlap from shared
 *  setting/genre vocabulary is normal and not penalized. */
function detectRepetition(story: QualityInput): number {
  if (!story.episodes?.length) return 0;
  let penalty = 0;

  const allNarration: string[] = [];
  for (const ep of story.episodes) {
    for (const sc of ep.scenes || []) {
      if (sc.narration) allNarration.push(sc.narration.toLowerCase());
    }
  }

  // Count 3-grams across the entire story. A trigram appearing more than
  // episodes * 2 times is genuinely repeated (e.g., "the old man" in 20+
  // scenes across a 10-episode story is likely a generation artifact).
  // M15: skip trigrams made ONLY of stopwords — ordinary English function-word
  // trigrams ("out of the", "she opened the") naturally exceed the threshold
  // in healthy stories and previously produced false −15 penalties that
  // triggered spurious refinement loops.
  const TRIGRAM_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
    'with', 'by', 'from', 'as', 'is', 'was', 'were', 'are', 'be', 'been',
    'it', 'its', 'he', 'she', 'his', 'her', 'him', 'they', 'them', 'their',
    'this', 'that', 'these', 'those', 'there', 'here', 'into', 'out', 'up',
    'down', 'over', 'under', 'then', 'than', 'so', 'such', 'no', 'not',
  ]);
  const isAllStopwords = (phrase: string): boolean =>
    phrase.split(' ').every((w) => TRIGRAM_STOPWORDS.has(w));

  const triGramCounts = new Map<string, number>();
  for (const text of allNarration) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = words.slice(i, i + 3).join(' ');
      if (isAllStopwords(phrase)) continue;
      triGramCounts.set(phrase, (triGramCounts.get(phrase) || 0) + 1);
    }
  }

  const epCount = story.episodes.length;
  let highlyRepeated = 0;
  for (const count of triGramCounts.values()) {
    if (count > epCount * 2) highlyRepeated += 1;
  }

  if (highlyRepeated > 5) penalty += 15;
  else if (highlyRepeated > 0) penalty += Math.min(10, highlyRepeated * 2);

  return penalty;
}

/** Penalize structural violations: missing narration, wildly inconsistent
 *  scene counts, empty hooks/cliffhangers. These are objective defects
 *  that make a story unpublishable regardless of writing quality. */
function detectStructuralIssues(story: QualityInput): number {
  if (!story.episodes?.length) return 20;
  let penalty = 0;

  // Missing narration in any scene
  const emptyNarrations = story.episodes.flatMap((ep) =>
    (ep.scenes || []).filter((s) => !s.narration || s.narration.trim().length < 10)
  );
  if (emptyNarrations.length > 3) penalty += Math.min(20, emptyNarrations.length * 3);

  // Scene count variance across episodes (should be uniform)
  const sceneCounts = story.episodes.map((ep) => ep.scenes?.length || 0);
  const avg = sceneCounts.reduce((a, b) => a + b, 0) / sceneCounts.length;
  const variance =
    sceneCounts.reduce((sum, c) => sum + (c - avg) ** 2, 0) / sceneCounts.length;
  if (variance > 3) penalty += 10;

  // Missing hooks or cliffhangers
  const missingHooks = story.episodes.filter((ep) => !ep.hook || ep.hook.trim().length < 5);
  if (missingHooks.length > story.episodes.length / 2) penalty += 10;

  const missingCliffs = story.episodes.filter((ep) => !ep.cliffhanger || ep.cliffhanger.trim().length < 5);
  if (missingCliffs.length > story.episodes.length / 2) penalty += 10;

  return penalty;
}

/** Penalize continuity issues: cliffhanger-to-hook mismatch, abrupt
 *  jumps between episodes. These are objective signals of broken
 *  narrative flow that the LLM might not penalize consistently. */
function detectContinuityIssues(story: QualityInput): number {
  if (!story.episodes?.length || story.episodes.length < 2) return 0;
  let penalty = 0;

  // Check that episodes have both hooks and cliffhangers (basic structural
  // continuity). Missing either breaks the viewer's sense of flow.
  for (let i = 0; i < story.episodes.length - 1; i++) {
    const ep = story.episodes[i]!;
    const next = story.episodes[i + 1]!;
    // If an episode has a cliffhanger but the next has no hook, the
    // continuity is broken — the viewer expects follow-through.
    if (ep.cliffhanger && ep.cliffhanger.length > 10 && (!next.hook || next.hook.length < 5)) {
      penalty += 5;
    }
  }

  return Math.min(20, penalty);
}
