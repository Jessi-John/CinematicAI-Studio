/**
 * Humanization Layer
 *
 * Evaluates and improves prose naturalness using rhythm-based analysis
 * rather than keyword blacklists. The key insight: AI-written text has
 * characteristic rhythm patterns (uniform sentence lengths, repetitive
 * sentence starts, low variance in structure) that are more reliable
 * signals than specific words the AI was told to avoid.
 *
 * When problematic sentences are identified, the system returns their
 * indices so the pipeline can rewrite ONLY those sentences instead of
 * regenerating the entire scene — preserving unaffected content.
 *
 * Lightweight deterministic cleanup (markdown, placeholders, robotic
 * openers) still runs as a safety net.
 */

// Patterns that are unambiguous AI-formatting artifacts — safe to strip.
const STRIP_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\*\*([^*]+)\*\*/g, replacement: '$1' },
  { pattern: /\*([^*]+)\*/g, replacement: '$1' },
  { pattern: /^#{1,6}\s+/gm, replacement: '' },
  { pattern: /\[\[([^\]]+)\]\]/g, replacement: '$1' },
  { pattern: /\{[a-z_]+\}/gi, replacement: '' },
  { pattern: /<think>[\s\S]*?<\/think>/gi, replacement: '' },
];

// Robotic sentence-start clichés that real writers avoid.
const OPENER_REPLACEMENTS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /^Suddenly,\s*/i, replacement: '' },
  { pattern: /^All of a sudden,\s*/i, replacement: '' },
  { pattern: /^Without warning,\s*/i, replacement: '' },
  { pattern: /^Little did they know,\s*/i, replacement: '' },
  { pattern: /^It is important to note that\s*/i, replacement: 'Notably, ' },
  { pattern: /^As you can see,?\s*/i, replacement: '' },
  { pattern: /^In this scene,?\s*/i, replacement: '' },
  { pattern: /^The scene opens with\s*/i, replacement: '' },
  { pattern: /^The camera reveals\s*/i, replacement: '' },
];

// Transition words that appear more than once per ~50 words indicate
// expository, non-natural prose.
const ROBOTIC_TRANSITIONS = [
  'however', 'therefore', 'moreover', 'furthermore', 'consequently',
  'nevertheless', 'nonetheless', 'thus', 'hence', 'accordingly',
];

export interface HumanizationResult {
  text: string;
  changes: string[];
  aiScore: number;
  /** Indices of sentences that contributed most to the score penalty.
   *  The pipeline can pass these to a targeted rewrite. */
  lowScoreSentences: number[];
}

export interface RhythmMetrics {
  sentenceStartVariety: number;
  sentenceLengthVariance: number;
  transitionDensity: number;
}

export class HumanizationService {
  /**
   * Process a scene: clean artifacts, compute rhythm-based aiScore,
   * identify problematic sentences for targeted rewrite.
   */
  process(text: string): HumanizationResult {
    let processed = text;
    const changes: string[] = [];

    // 1. Strip AI-formatting artifacts
    for (const { pattern, replacement } of STRIP_PATTERNS) {
      const before = processed;
      processed = processed.replace(pattern, replacement);
      if (before !== processed) changes.push(`stripped: ${pattern.source.slice(0, 30)}`);
    }

    // 2. Clean up sentence-start AI clichés
    for (const { pattern, replacement } of OPENER_REPLACEMENTS) {
      const before = processed;
      processed = processed.replace(pattern, replacement);
      if (before !== processed) changes.push(`opener: ${pattern.source.slice(0, 30)}`);
    }

    // 3. Collapse whitespace
    processed = processed.replace(/[ \t]{2,}/g, ' ').trim();

    // LIVE-4: Ensure a space after sentence-ending punctuation when followed
    // by a letter. Raw model output and regenerated scenes can produce
    // missing inter-sentence whitespace ("warm.Nilah's" or "breathed.Inside").
    processed = processed.replace(/([.!?])([A-Za-z])/g, '$1 $2');

    return {
      text: processed,
      changes,
      aiScore: this.calculateAiScore(processed),
      lowScoreSentences: this.identifyLowScoreSentences(processed),
    };
  }

  /**
   * Rhythm-based aiScore. Higher = more human-like.
   *
   * Evaluates:
   * - Sentence-start variety (do all sentences start differently?)
   * - Sentence-length variance (are lengths naturally distributed?)
   * - Transition density (too many "however/therefore" = expository)
   *
   * Does NOT use keyword blacklists (delve, utilize, etc.) — those are
   * gameable and don't measure actual naturalness.
   */
  calculateAiScore(text: string): number {
    let score = 100;
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length < 2) return score;

    const metrics = this.analyzeRhythm(sentences);

    // Sentence-start variety: if fewer than 60% of sentences start with a
    // different first-word, the rhythm is repetitive. Penalty scales linearly.
    if (metrics.sentenceStartVariety < 0.6) {
      score -= Math.round((0.6 - metrics.sentenceStartVariety) * 40);
    }

    // Sentence-length variance: low variance = all sentences same length =
    // robotic cadence. The penalty scales with how far below threshold.
    if (metrics.sentenceLengthVariance < 5) {
      score -= Math.round((5 - metrics.sentenceLengthVariance) * 4);
    } else if (metrics.sentenceLengthVariance < 10) {
      score -= Math.round((10 - metrics.sentenceLengthVariance) * 2);
    }

    // Transition density: more than 1 transition per 50 words = expository.
    // Penalize proportionally above the threshold.
    if (metrics.transitionDensity > 0.02) {
      const excess = metrics.transitionDensity - 0.02;
      score -= Math.round(Math.min(20, excess * 200));
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Identify which specific sentences are dragging down the score.
   * Returns 0-based indices of sentences that:
   * - Start with the same word as a nearby sentence
   * - Have near-identical length to surrounding sentences
   * - Contain excessive transition words
   */
  identifyLowScoreSentences(text: string): number[] {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const badIndices: Set<number> = new Set();

    if (sentences.length < 3) return [];

    // Find sentences whose first word matches a nearby sentence's first word
    const firstWords = sentences.map((s) => s.trim().split(/\s+/)[0]?.toLowerCase() || '');
    for (let i = 0; i < firstWords.length; i++) {
      for (let j = Math.max(0, i - 2); j <= Math.min(firstWords.length - 1, i + 2); j++) {
        if (i !== j && firstWords[i] === firstWords[j]) {
          badIndices.add(i);
          badIndices.add(j);
        }
      }
    }

    // Find sentences whose length is within 2 words of both neighbors
    if (sentences.length >= 3) {
      const lengths = sentences.map((s) => s.split(/\s+/).length);
      for (let i = 1; i < lengths.length - 1; i++) {
        if (Math.abs(lengths[i]! - lengths[i - 1]!) <= 2 &&
            Math.abs(lengths[i]! - lengths[i + 1]!) <= 2) {
          badIndices.add(i);
        }
      }
    }

    // Find sentences with excessive transitions
    for (let i = 0; i < sentences.length; i++) {
      const lower = sentences[i]!.toLowerCase();
      // L27: word-boundary matching — substring matching counted "thus"
      // inside "enthusiastic" and "hence" inside "henceforth" as transitions.
      const transitionCount = ROBOTIC_TRANSITIONS.filter((t) =>
        new RegExp(`\\b${t.replace(/\s+/g, '\\s+')}\\b`, 'i').test(lower)
      ).length;
      if (transitionCount >= 2) badIndices.add(i);
    }

    return Array.from(badIndices).sort((a, b) => a - b);
  }

  /**
   * Analyze writing rhythm from an array of sentences.
   */
  analyzeRhythm(sentences: string[]): RhythmMetrics {
    // Sentence-start variety: proportion of unique first-words
    const firstWords = sentences.map((s) => s.trim().split(/\s+/)[0]?.toLowerCase() || '');
    const uniqueStarts = new Set(firstWords);
    const sentenceStartVariety = sentences.length > 0
      ? uniqueStarts.size / sentences.length
      : 0;

    // Sentence-length variance
    const lengths = sentences.map((s) => s.split(/\s+/).length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sentenceLengthVariance = lengths.length > 1
      ? lengths.reduce((sum, len) => sum + (len - avg) ** 2, 0) / lengths.length
      : 0;

    // Transition density: count of robotic transitions per word
    const totalWords = lengths.reduce((a, b) => a + b, 0);
    const allText = sentences.join(' ').toLowerCase();
    let transitionCount = 0;
    for (const t of ROBOTIC_TRANSITIONS) {
      const regex = new RegExp(`\\b${t}\\b`, 'gi');
      const matches = allText.match(regex);
      if (matches) transitionCount += matches.length;
    }
    const transitionDensity = totalWords > 0 ? transitionCount / totalWords : 0;

    return { sentenceStartVariety, sentenceLengthVariance, transitionDensity };
  }

  detectRepetition(
    text: string,
    previousTexts: string[] = []
  ): {
    hasRepetition: boolean;
    repeatedPhrases: string[];
    similarityScore: number;
  } {
    const repeatedPhrases: string[] = [];
    const words = text.toLowerCase().split(/\s+/);

    const triGramCounts = new Map<string, number>();
    for (let i = 0; i < words.length - 2; i++) {
      const phrase = words.slice(i, i + 3).join(' ');
      triGramCounts.set(phrase, (triGramCounts.get(phrase) ?? 0) + 1);
    }
    for (const [phrase, count] of triGramCounts) {
      if (count > 2) repeatedPhrases.push(phrase);
    }

    let maxSim = 0;
    for (const prev of previousTexts) {
      maxSim = Math.max(maxSim, this.similarity(text, prev));
    }

    let threshold = 0.7;
    if (previousTexts.length >= 3) {
      const pairwiseSims: number[] = [];
      for (let i = 0; i < previousTexts.length; i++) {
        for (let j = i + 1; j < previousTexts.length; j++) {
          pairwiseSims.push(this.similarity(previousTexts[i]!, previousTexts[j]!));
        }
      }
      pairwiseSims.sort((a, b) => a - b);
      const median = pairwiseSims[Math.floor(pairwiseSims.length / 2)]!;
      threshold = Math.min(0.95, median + 0.15);
    }

    return {
      hasRepetition: repeatedPhrases.length > 0 || maxSim > threshold,
      repeatedPhrases,
      similarityScore: maxSim,
    };
  }

  private similarity(text1: string, text2: string): number {
    const w1 = new Set(text1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const w2 = new Set(text2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (w1.size === 0 || w2.size === 0) return 0;
    let intersect = 0;
    for (const w of w1) if (w2.has(w)) intersect += 1;
    const union = w1.size + w2.size - intersect;
    return union > 0 ? intersect / union : 0;
  }
}

export const humanization = new HumanizationService();
