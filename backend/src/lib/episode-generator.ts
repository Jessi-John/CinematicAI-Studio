/**
 * Connected Episode Generation System
 *
 * Generates 10 interconnected episodes with:
 * - Continuous arcs (cliffhanger -> next hook)
 * - 5 scenes per episode with retry + similarity rejection
 * - Per-episode word-budget targeting toward ~50 seconds of narration
 * - Cross-episode opening-phrase dedupe
 * - Per-genre fallbacks if AI fails
 */

import { generateWithMistral } from './ai-client.js';
import { sleep } from './sleep.js';
import { sanitizeAIResponse, safeJsonParse } from './sanitize.js';
import { sanitizeForPrompt, sanitizeArrayForPrompt } from './sanitize-prompt.js';
import { formatGenreDirective, formatGenreDirectiveForEpisode } from './genre-directives.js';
import {
  validateBlueprintGenre,
  buildGenreGuardCorrectionNote,
  GenreGuardViolationError,
  isGenreGuardViolationError,
  validateEpisodeOutlineGenre,
} from './genre-guard.js';
import type { CharacterBible } from '../services/character-bible.js';
import { logRetry, logFallback } from '../services/generation-logger.js';
import { logger } from '../services/logger.js';
import {
  targetEpisodeWordsMin,
  targetEpisodeWordsMax,
  targetWordsPerScene,
  scenesPerEpisode,
} from './timing.js';

export interface EpisodeContext {
  episodeNumber: number;
  storyTitle: string;
  genre: string;
  protagonistName: string;
  protagonistAge: string;
  // M31: Protagonist gender for pronoun consistency. The scene-narration
  // prompt and the GENRE_FALLBACK_SCENES templates both use this. The
  // field is optional for backward compatibility — older call sites that
  // pass EpisodeContext without it will default to 'neutral' pronouns
  // (they/them) which never misgender the protagonist.
  protagonistGender?: 'male' | 'female' | 'neutral';
  setting: string;
  previousEpisodeSummary?: string;
  previousCliffhanger?: string;
  theme: string;
  characterBible?: CharacterBible;
  // Cross-episode dedupe: full narrationText of scenes from prior episodes.
  priorOpenings?: string[];
  // Uniqueness constraints surfaced from the database.
  avoidanceConstraints?: string[];
  // L4-EP-TITLE: Titles already used in this story (story title + other
  // episode titles). Passed to meta generation so regenerated episodes do
  // not duplicate existing titles.
  usedTitles?: string[];
}

export interface GeneratedEpisode {
  title: string;
  hook: string;
  synopsis: string;
  scenes: string[];
  cliffhanger: string;
  episodeSummary: string;
}

export interface StoryBlueprint {
  title: string;
  protagonistName: string;
  protagonistAge: string;
  // M31: Protagonist gender ("male" | "female" | "neutral"). The AI prompt
  // for scene narration embeds the pronoun set derived from this field, and
  // the GENRE_FALLBACK_SCENES templates substitute it. Without this, the LLM
  // defaults to female pronouns for fantasy and the hardcoded fallback
  // templates literally say "her heel" / "she drops" regardless of the
  // protagonist's actual gender.
  //
  // Optional on the interface for backward compat with pre-M31
  // StoryCheckpoint JSON blobs that did not persist the gender (older
  // resumes default to 'neutral' pronouns, which is the safe fallback).
  protagonistGender?: 'male' | 'female' | 'neutral';
  setting: string;
  theme: string;
  logline: string;
  /** Set when blueprint generation failed and a fallback was used. */
  _fallback?: true;
  /** The error message from the failed blueprint generation. */
  _fallbackError?: string;
}

/**
 * Pronoun set for a given gender. `subject` is "he/she/they", `object` is
 * "him/her/them", `possessive` is "his/her/their". `reflexive` is
 * "himself/herself/themself". The story-builder and scene-narration
 * prompts inject these so the LLM uses the correct pronouns for the
 * protagonist across every scene.
 */
export interface PronounSet {
  subject: 'he' | 'she' | 'they';
  object: 'him' | 'her' | 'them';
  possessive: 'his' | 'her' | 'their';
  reflexive: 'himself' | 'herself' | 'themself';
}

const PRONOUNS: Record<'male' | 'female' | 'neutral', PronounSet> = {
  male: { subject: 'he', object: 'him', possessive: 'his', reflexive: 'himself' },
  female: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
  neutral: { subject: 'they', object: 'them', possessive: 'their', reflexive: 'themself' },
};

export function pronounsFor(gender: 'male' | 'female' | 'neutral' | undefined): PronounSet {
  if (gender === 'male' || gender === 'female' || gender === 'neutral') {
    return PRONOUNS[gender];
  }
  // M31: Default to neutral pronouns for unknown/missing gender rather than
  // guessing male/female. Using "they" is the safe fallback — it never
  // misgenders a protagonist and reads naturally in third-person narration.
  return PRONOUNS.neutral;
}

function normalizeGender(raw: unknown): 'male' | 'female' | 'neutral' {
  if (typeof raw !== 'string') return 'neutral';
  const lower = raw.toLowerCase().trim();
  if (lower === 'male' || lower === 'm' || lower === 'man' || lower === 'boy' || lower === 'masculine') return 'male';
  if (lower === 'female' || lower === 'f' || lower === 'woman' || lower === 'girl' || lower === 'feminine') return 'female';
  if (lower === 'neutral' || lower === 'nonbinary' || lower === 'non-binary' || lower === 'nb' || lower === 'enby' || lower === 'they') return 'neutral';
  return 'neutral';
}

const SCENE_MAX_RETRIES = 3;
const META_MAX_RETRIES = 3;
const BLUEPRINT_MAX_RETRIES = 5;
// L4-EP-TITLE: separate retry budget for the title-uniqueness safety net.
// Each retry is a single short AI turn (very cheap), so 3 retries is
// negligible overhead and gives the model a clear chance to fix a
// duplicate or "Episode N" prefix.
const TITLE_UNIQUE_RETRIES = 3;
const REBALANCE_MAX_PASSES = 2;
const RETRY_DELAY_MS = 1000;
const SIMILARITY_THRESHOLD = 0.7;

// Spec: episode = ~50s spoken narration. The exact word band is centralized in
// ./timing.ts so worker, builder, exporter, and DB defaults never drift apart.
// 115-130 words ≈ 47.6-53.8 s @ 145 WPM.

// ---------- Helpers ----------

export function getOpeningPhrase(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join(' ');
}

function calculateSimilarity(text1: string, text2: string): number {
  const w1 = new Set(text1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const w2 = new Set(text2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (w1.size === 0 || w2.size === 0) return 0;
  let intersect = 0;
  for (const w of w1) if (w2.has(w)) intersect += 1;
  const union = w1.size + w2.size - intersect;
  return union > 0 ? intersect / union : 0;
}

export function isSceneTooSimilar(newScene: string, previous: string[]): boolean {
  const newOpening = getOpeningPhrase(newScene);
  for (const prev of previous) {
    if (calculateSimilarity(newOpening, getOpeningPhrase(prev)) > SIMILARITY_THRESHOLD) return true;
    if (calculateSimilarity(newScene, prev) > 0.6) return true;
  }
  return false;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateSceneQuality(
  text: string,
  hook: string,
  episodeNumber: number,
  sceneNumber: number,
  previousLocal: string[],
  priorEpisodeScenes: string[] = [],
  genre: string = ''
): { valid: boolean; reason?: string } {
  if (wordCount(text) < 10) return { valid: false, reason: 'too_few_words' };
  if (text.includes(`Episode ${episodeNumber}`) || text.includes(`scene ${episodeNumber}`)) {
    return { valid: false, reason: 'has_episode_reference' };
  }
  const lower = text.toLowerCase();
  if (
    lower.includes('hook') ||
    lower.includes('synopsis') ||
    lower.includes('requirements') ||
    lower.includes('write episode')
  ) {
    return { valid: false, reason: 'has_forbidden_keyword' };
  }
  // Reject the robotic openers we forbid in the system prompt; otherwise the
  // model's lapses leak through unchecked.
  if (
    /^\s*(however|therefore|moreover|furthermore|suddenly|all of a sudden|without warning|in this scene|the scene opens with)\b[ ,]/i.test(
      text
    )
  ) {
    return { valid: false, reason: 'robotic_opener' };
  }
  if (text === hook || (hook.length > 20 && text.includes(hook.substring(0, 40)))) {
    return { valid: false, reason: 'too_similar_to_hook' };
  }
  if (previousLocal.length > 0 && isSceneTooSimilar(text, previousLocal)) {
    return { valid: false, reason: 'too_similar_to_previous_in_episode' };
  }
  // Cross-episode dedupe: full scene content check against prior episodes.
  if (priorEpisodeScenes.length > 0 && isSceneTooSimilar(text, priorEpisodeScenes)) {
    return { valid: false, reason: 'too_similar_to_prior_episode' };
  }

  // Reject scenes with uniform sentence lengths — mirrors the -20 aiScore
  // penalty in the humanization service. The threshold scales with the number
  // of sentences because short scenes (2-3 sentences) have an upper bound on
  // achievable variance that is below any fixed cutoff. With N sentences,
  // max theoretical variance = ((N-1)² + (N-1)² + ... + (0)²) / N, which for
  // N=3 is just ~0.67 for uniform distributions. The threshold formula
  // `max(2, N - 2)` gives: N=2→skip (always uniform), N=3→1, N=4→2, N=5→3,
  // etc., matching the available degrees of freedom.
  const sents = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0);
  const varianceThreshold = sents.length >= 3 ? Math.max(2, sents.length - 2) : -1;
  if (varianceThreshold > 0) {
    const lengths = sents.map((s: string) => s.split(/\s+/).length);
    const avg = lengths.reduce((a: number, b: number) => a + b, 0) / lengths.length;
    const variance =
      lengths.reduce((sum: number, len: number) => sum + (len - avg) ** 2, 0) / lengths.length;
    if (variance < varianceThreshold) {
      return { valid: false, reason: 'uniform_sentence_lengths' };
    }
  }

  if (/^(scene|episode|shot):/i.test(text)) return { valid: false, reason: 'is_meta' };
  if (/^[^a-zA-Z]/.test(text)) return { valid: false, reason: 'not_sentence' };

  // Scene 5 must end on a genre-appropriate hook — tension genres need a
  // cliffhanger; gentle/uplifting genres also accept warm, humorous, hopeful,
  // or curious endings. Uses isStrongGenreEnding (multi-signal detection)
  // instead of a single regex, so light genres are no longer force-rewritten
  // into dread.
  if (sceneNumber === 5) {
    const lastSentence = text.split(/[.!?]+/).filter((s: string) => s.trim().length > 0).pop()?.trim() || '';
    if (!isStrongGenreEnding(lastSentence, genre)) {
      return { valid: false, reason: 'missing_cliffhanger' };
    }
  }

  return { valid: true };
}

function extractNarration(response: string, sceneNumber: number): string {
  let text = response.trim();

  text = text
    .replace(/^["']|["']$/g, '')
    .replace(new RegExp(`^(episode\\s*\\d+\\s*)?scene\\s*${sceneNumber}[.:]\\s*`, 'i'), '')
    .replace(/^scene\s*\d+[.:]\s*/i, '')
    .replace(/^narration[.:]\s*/i, '')
    .replace(/^voiceover[.:]\s*/i, '')
    .replace(/^"([^"]+)"/g, '$1')
    .replace(/^'([^']+)'/g, '$1')
    .replace(/^\.{2,}\s*/, '')
    .replace(/\.{2,}\s*$/, '')
    .replace(new RegExp(`^scene\\s*${sceneNumber}\\s*of\\s*\\d+\\s*`, 'i'), '');

  text = text.replace(/^\s*\d+[.)]\s*/, '');
  text = text.replace(/^\s*[-•*]\s*/, '');
  text = text.replace(/^\s*\([^)]*\)\s*/i, '');
  text = text.trim();

  // Allow up to ~3 sentences instead of clipping after the first one.
  // We want ~24 words (~10s) per scene; trimming to first sentence cuts to ~12.
  return text;
}

// ---------- Single scene ----------

export async function generateSingleScene(
  sceneNumber: number,
  episodeNumber: number,
  storyTitle: string,
  protagonistName: string,
  genre: string,
  episodeSynopsis: string,
  previousSceneSummary: string | null,
  characterBible?: CharacterBible,
  humanizationRetry?: boolean,
  // Optional override; if omitted, uses the module-level targetWordsPerScene
  // from timing.js (which reflects SystemSettings overrides loaded at pipeline start).
  targetWordsPerSceneOverride?: number,
  // M31: Protagonist gender for pronoun consistency. Defaults to 'neutral'
  // so the LLM uses they/them if no gender was provided (avoids the prior
  // bug where the LLM defaulted to female pronouns for fantasy).
  protagonistGender: 'male' | 'female' | 'neutral' = 'neutral',
  // FIX: Specific repetitive phrases detected by the humanization service.
  // When provided, the retry prompt includes these exact phrases so the model
  // knows what to avoid. Previously the prompt was generic ("too formulaic or
  // AI-sounding") with no specific feedback, so the model rewrote using the
  // same repetitive patterns and every retry wasted an API call.
  repetitivePhrases?: string[],
  /** 0-based indices of sentences with rhythm problems. When provided, the
   *  retry prompt includes the text of these sentences so the model rewrites
   *  them specifically rather than regenerating the whole scene blindly. */
  targetSentences?: number[],
  /** Narration text from scenes in OTHER episodes, provided as cross-episode
   *  context. When set, the model is instructed to avoid reusing any phrasing,
   *  sentence structure, or opening words from these existing narrations.
   *  This is the PRIMARY defense against cross-episode duplicate narration:
   *  the model must know what it already wrote to avoid repeating itself. */
  priorNarrations?: string[]
): Promise<string> {
  const sceneWordTarget = targetWordsPerSceneOverride ?? targetWordsPerScene;
  let systemPrompt = `You are a human novelist writing a ${genre} story that will be narrated as a YouTube Shorts voiceover. Your prose is read aloud at ~145 words per minute. Write the way real novelists write — not like an AI.

PRONOUN CONSISTENCY: The user message specifies the protagonist's pronoun set (he/him/his, she/her/her, or they/them/their). Use those pronouns EXACTLY and consistently — never switch mid-scene, never default to a different set because the genre "feels" that way. Mismatched pronouns (e.g. "Sorin drives her heel" when Sorin uses he/him) break immersion and force a costly rewrite.

THE MOST IMPORTANT RULE: Every scene must sound like it was written by a person, not generated by a machine. Read each sentence back in your head. If it sounds stiff, formal, or formulaic, rewrite it.

WORD COUNT TARGET: This scene should be ~${sceneWordTarget} words (range: ${Math.max(18, sceneWordTarget - 4)}–${sceneWordTarget + 6}). The episode must total ${targetEpisodeWordsMin}-${targetEpisodeWordsMax} words across 5 scenes. Hitting this target on the first try avoids a costly re-pass — but never pad with filler or trim meaningful detail just to hit the number.

HOW REAL WRITERS WRITE:
- Sentence length varies naturally within a scene (some short, some long) — but the TOTAL word count must hit the target above. The target is a hard constraint, not a guide. Sentence-length variation is about how the words distribute, not whether the count is right.
- Every sentence starts differently. Never let two consecutive sentences begin the same way (not with the same name, the same verb, or the same structure).
- Active verbs, specific nouns. Not "walked" — "slipped", "stumbled", "crept." Not "the thing" — "the rusted key", "the cracked mirror."
- Sensory details that land: the smell of wet stone, the weight of a coat, the sound of footsteps echoing.
- Contractions and fragments. People don't say "they are" — they say "they're." A one-word sentence like "Silence." can be more powerful than a full sentence.
- Avoid ANY transition words: however, therefore, moreover, furthermore, consequently, nonetheless, thus. Real writers don't use them.
- Avoid ANY filler openings: Suddenly, All of a sudden, Without warning, In this scene, The scene opens with, It is important to note that, As you can see, Little did they know.
- No two scenes across the entire story should share the same opening phrase or similar action.
${sceneEndingGuidance(genre)}
- Stay in ${genre} mood. A fantasy scene feels different from a thriller scene.
- No labels, no headings, no scene numbers. Just the prose.

SENTENCE STRUCTURE — CRITICAL: Never write two sentences of similar length in a row. The sentence lengths within a single scene must be varied, not uniform.

GOOD (varied sentence lengths — notice the pattern):
  "She pressed her palm to the cold stone." (8 words)
  "It groaned." (2 words)
  "She stumbled back as dust rained from above." (9 words)
  Lengths: 8, 2, 9 — varied ✓

GOOD:
  "The door swung open." (4 words)
  "Beyond it, a vast hall stretched into darkness, its ceiling lost in shadow." (14 words)
  Lengths: 4, 14 — varied ✓

BAD (uniform sentence lengths — never do this):
  "She pressed the cold stone." (4 words)
  "The door groaned loudly." (4 words)
  "She stumbled backward." (3 words)
  Lengths: 4, 4, 3 — uniform ✗

BAD:
  "The room was dark and cold." (6 words)
  "The door swung open wide." (5 words)
  "She stepped into the dark." (5 words)
  Lengths: 6, 5, 5 — uniform ✗

YOUTUBE MONETIZATION RULES (advertiser-friendly):
- No graphic violence, gore, sexual content, slurs, or self-harm depiction.
- No drug or weapon glorification. No real-person impersonation.
- Themes appropriate for a YouTube Shorts general audience.
- 100% original. Never reference any copyrighted franchise, character, or setting.`;

  if (humanizationRetry) {
    let retryPrompt = `
 
 HUMANIZATION RETRY: The previous version of this scene was flagged as too formulaic or AI-sounding. You MUST rewrite from scratch. Follow these rules strictly:
 - Every sentence must start with a different word. Scan your sentences — if any two start the same way, rewrite one.
 - Vary sentence lengths dramatically. Never write two sentences of similar length in a row. Check your sentence word counts and make sure they're different.
 - CORRECT pattern: A short sentence (2-4 words), then a long one (10-15 words), then a medium one (5-8 words), then another short one. Mix them up.
 - WRONG pattern: Two or more sentences with the same word count in a row. This is what made the previous version fail.
 - Use fragments. Use one-word sentences. Use dashes for interruption — like this.
 - No two scenes in this story should use any of the same verbs. If another scene used "reached" or "pulled" or "stepped," choose something completely different.
 - Write at a conversational level — like you're telling a friend what happened, not writing an essay.
 - Read it aloud. If it doesn't sound like natural speech, delete it and start over.`;
     if (repetitivePhrases && repetitivePhrases.length > 0) {
       retryPrompt += `

  SPECIFIC PHRASES TO AVOID (these exact 3-word phrases appeared too many times in the previous version):
${repetitivePhrases.map((p) => `   - "${p}"`).join('\n')}
 Do NOT use any of these phrases or their close variants. Rewrite each occurrence with completely different words and sentence structure.`;
     }
     if (targetSentences && targetSentences.length > 0) {
       retryPrompt += `

 TARGETED REWRITE: Sentences at indices [${targetSentences.join(', ')}] have rhythm problems (repetitive starts, uniform lengths, or excessive transitions). Focus on fixing these specific sentences when you rewrite. Pay special attention to varying their starting words and lengths relative to surrounding text.`;
     }
     systemPrompt += retryPrompt;
  }

  // Scene progression guidance — not rigid beats, just a natural arc for the 5 scenes
  const sceneProgressions = [
    'Something shifts — a small action that sets things in motion',
    'A discovery or realization — the character sees, hears, or understands something new',
    'Movement or change — the character moves through space or makes a decision',
    'A complication — something (or someone) pushes back',
    finalSceneProgression(genre),
  ];

  const userPrompt = `Scene ${sceneNumber} of 5 for "${sanitizeForPrompt(storyTitle)}" (${sanitizeForPrompt(genre)}). Episode ${episodeNumber}: ${sanitizeForPrompt(episodeSynopsis)}

${previousSceneSummary ? `Previous scene ended with: ${sanitizeForPrompt(previousSceneSummary)}` : ''}

${characterBible ? `Character: ${sanitizeForPrompt(protagonistName)}
Appearance: ${sanitizeForPrompt(characterBible.facialFeatures)}
Clothing: ${sanitizeForPrompt(characterBible.clothing)}
Mannerisms: ${sanitizeForPrompt(characterBible.physicalMannerisms)}` : ''}
Pronouns for the protagonist: ${pronounsFor(protagonistGender).subject}/${pronounsFor(protagonistGender).object}/${pronounsFor(protagonistGender).possessive}. Use these pronouns EXACTLY when referring to ${sanitizeForPrompt(protagonistName)} — do not switch between pronouns mid-scene.

Scene role: ${sanitizeForPrompt(sceneProgressions[sceneNumber - 1] || sceneProgressions[0])}
${priorNarrations && priorNarrations.length > 0 ? `
EXISTING NARRATION IN OTHER EPISODES — DO NOT REPEAT:
The following narration text is already used in other episodes of this story. Your scene MUST use completely different phrasing, verbs, openings, and sentence structures. Never reuse any phrase, action, or sentence pattern from these existing texts.
${priorNarrations.map((n, i) => `[Existing scene ${i + 1}]: ${n.substring(0, 100)}${n.length > 100 ? '…' : ''}`).join('\n')}
` : ''}
Write one short paragraph of prose. You MUST hit the target of ~${sceneWordTarget} words (hard range: ${Math.max(18, sceneWordTarget - 4)} to ${sceneWordTarget + 6}). Hitting the target is required — too short and the narration leaves dead air, too long and the next scene gets cut. Vary your sentence count, but keep the total word count within the range. Output the prose only.`;

  const response = await generateWithMistral(systemPrompt, userPrompt);
  return extractNarration(response, sceneNumber);
}

// ---------- Post-generation pronoun consistency fix ----------

/**
 * Deterministic pronoun consistency repair.
 *
 * Builds a complete replacement map for each gender→gender transition
 * and applies it sentence-by-sentence. Handles the "her" ambiguity
 * (object vs possessive) by preferring the possessive form in narration
 * prose, which is statistically more common in third-person narrative.
 *
 * For sentences naming the protagonist, ALL pronouns are realigned.
 * For anonymous sentences between protagonist references, pronouns are
 * realigned only when no other named character appears nearby.
 */
const PRONOUN_REPLACEMENTS: Record<string, Record<string, string>> = {
  male: {
    she: 'he', her: 'his', hers: 'his', herself: 'himself',
    they: 'he', them: 'him', their: 'his', theirs: 'his', themself: 'himself',
  },
  female: {
    he: 'she', him: 'her', his: 'her', himself: 'herself',
    they: 'she', them: 'her', their: 'her', theirs: 'hers', themself: 'herself',
  },
  neutral: {
    he: 'they', him: 'them', his: 'their', himself: 'themself',
    she: 'they', her: 'their', hers: 'theirs', herself: 'themself',
  },
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fixPronounMismatches(
  text: string,
  protagonistName: string,
  protagonistGender: 'male' | 'female' | 'neutral',
  /** MEDIUM #35: named entities (antagonist, supporting, places, etc.) so
   *  the continuation pass does not rewrite pronouns that belong to another
   *  character. */
  otherNamedEntities: string[] = []
): { text: string; changes: string[] } {
  const changes: string[] = [];
  const replacements = PRONOUN_REPLACEMENTS[protagonistGender];
  if (!replacements) return { text, changes };

  const nameLower = protagonistName.toLowerCase();
  const sentences = text.split(/(?<=[.!?])\s+/);

  // Build a case-insensitive set of known named entities (excluding the
  // protagonist). We match with word boundaries so short names like "Ren"
  // do not match inside longer words.
  const otherNames = new Set(
    otherNamedEntities
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && n.toLowerCase() !== nameLower)
  );
  const otherNameRegexes = [...otherNames].map(
    (n) => new RegExp(`\\b${escapeRegex(n)}\\b`, 'i')
  );

  // Pass 1: Fix sentences naming the protagonist
  const pass1 = sentences.map((s) => {
    if (!s.toLowerCase().includes(nameLower)) return s;
    let fixed = s;
    for (const [from, to] of Object.entries(replacements)) {
      const regex = new RegExp(`\\b${from}\\b`, 'gi');
      const before = fixed;
      fixed = fixed.replace(regex, (match) =>
        match[0]! === match[0]!.toUpperCase()
          ? to[0]!.toUpperCase() + to.slice(1)
          : to
      );
      if (before !== fixed) {
        changes.push(`pronoun: "${from}" → "${to}" near "${protagonistName}"`);
      }
    }
    return fixed;
  });

  // Pass 2: Fix anonymous continuation sentences (no named characters).
  // MEDIUM #35: use the explicit entity list instead of a heuristic that
  // misclassified proper nouns, places, and capitalized common nouns.
  const pass2 = [...pass1];
  for (let i = 0; i < pass2.length; i++) {
    if (pass2[i]!.toLowerCase().includes(nameLower)) continue;
    const hasOtherName = otherNameRegexes.some((re) => re.test(pass2[i]!));
    if (hasOtherName) continue;
    const contextHasName =
      (i > 0 && pass1[i - 1]!.toLowerCase().includes(nameLower)) ||
      (i > 1 && pass1[i - 2]!.toLowerCase().includes(nameLower)) ||
      (i < pass1.length - 1 && pass1[i + 1]!.toLowerCase().includes(nameLower));
    if (!contextHasName) continue;
    let fixed = pass2[i]!;
    for (const [from, to] of Object.entries(replacements)) {
      const regex = new RegExp(`\\b${from}\\b`, 'gi');
      const before = fixed;
      fixed = fixed.replace(regex, (match) =>
        match[0]! === match[0]!.toUpperCase()
          ? to[0]!.toUpperCase() + to.slice(1)
          : to
      );
      if (before !== fixed) {
        changes.push(`pronoun: "${from}" → "${to}" (continuation from "${protagonistName}" context)`);
      }
    }
    pass2[i] = fixed;
  }

  return { text: pass2.join(' '), changes };
}

/**
 * Evaluate cliffhanger quality of a scene-ending sentence.
 * Returns true if the sentence creates narrative tension.
 * Uses a combination of structural and semantic signals rather than
 * a single regex, catching weak cliffhangers that pass simple checks.
 */
export function isStrongCliffhanger(lastSentence: string): boolean {
  if (!lastSentence || lastSentence.trim().length < 3) return false;
  const s = lastSentence.trim();

  // Direct question hook
  if (s.endsWith('?')) return true;

  // Trailing-off tension (ellipsis or dash)
  if (/\.\.\.$|—$|–$/.test(s)) return true;

  // Unresolved action verbs
  const unresolvedVerbs = /\b(about to|just before|reached for|reaches for|stepped? toward|steps? toward|moves? toward|turns? to|waits? for|watch(es|ing)? as|listen(s|ing)? as|feel(s|ing)? as|senses?|hear(s|ing)?|see(s|ing)?|spot(s|ing)?|catching? sight of)\b/i;
  if (unresolvedVerbs.test(s)) return true;

  // Negative or uncertain framing
  const uncertaintyWords = /\b(didn't|wasn't|couldn't|wouldn't|shouldn't|might not|may not|not yet|not sure|no idea|unknown|unseen|unanswered|unsolved|unresolved|unfinished)\b/i;
  if (uncertaintyWords.test(s)) return true;

  // Implied questions
  const wonderWords = /\b(wondered|wondering|unknown|what lay|what waited|what awaited|what came next|what happens)\b/i;
  if (wonderWords.test(s)) return true;

  // Emotional tension
  const tensionWords = /\b(held|held? their breath|heart pound(s|ing|ed)?|raced?|froze?|frozen|chill|dread|fear|foreboding|ominous|silence|stillness|waiting|anticipation)\b/i;
  if (tensionWords.test(s)) return true;

  // Present-moment unresolved action
  const presentAction = /\b(creaks?|cracks?|crumbles?|shakes?|trembles?|flickers?|fades?|emerges?|rises?|looms?|approaches?|descend(s|ing)?|ascend(s|ing)?)\b/i;
  if (presentAction.test(s) && /\b(as|while|when|and then|before)\b/i.test(s)) return true;

  return false;
}

// ---------- Genre-aware scene endings ----------
//
// Root-cause fix for cross-genre tone bleed: previously EVERY genre was forced
// to end every scene on a tension hook ("never end with a resolved, peaceful
// conclusion"), and validateSceneQuality hard-rejected scene-5 endings that
// lacked cliffhanger signals. For light genres (kids, comedy, slice-of-life)
// and heart-led genres (romance, drama, emotional, inspirational) this dragged
// the narration toward dread and supernatural menace. Endings are now
// genre-aware: each genre gets an ending STYLE, matching prompt guidance, and
// a matching deterministic validator.

export type EndingStyle = 'tension' | 'gentle' | 'uplifting';

const ENDING_STYLE_BY_GENRE: Record<string, EndingStyle> = {
  kids: 'gentle',
  comedy: 'gentle',
  'slice-of-life': 'gentle',
  romance: 'uplifting',
  drama: 'uplifting',
  emotional: 'uplifting',
  inspirational: 'uplifting',
};

export function endingStyleForGenre(genre: string): EndingStyle {
  return ENDING_STYLE_BY_GENRE[genre.toLowerCase()] ?? 'tension';
}

/** Prompt block replacing the one-size-fits-all "SCENE ENDINGS" mandate. */
export function sceneEndingGuidance(genre: string): string {
  const style = endingStyleForGenre(genre);
  if (style === 'gentle') {
    return '- SCENE ENDINGS — IMPORTANT: End each scene on a beat that fits this lighthearted genre: a laugh, a warm moment, a small discovery, or a gentle question that makes the viewer curious about what comes next. Warmth, humor, and curiosity keep this audience watching — not dread. Never end on ominous menace, lurking threats, horror-style foreboding, or a character paralyzed with fear.';
  }
  if (style === 'uplifting') {
    return '- SCENE ENDINGS — IMPORTANT: End each scene on an emotionally resonant beat — a moment of hope, connection, realization, or heartfelt anticipation that makes the viewer want the next scene. Pull the viewer forward with feeling, not with danger. Never end on ominous menace, lurking threats, or horror-style foreboding.';
  }
  return '- SCENE ENDINGS — CRITICAL: Every scene must end on a hook, question, or moment of tension. The last sentence is what keeps the viewer watching the next scene. End with something unresolved: a sound off-screen, a choice not yet made, a door cracking open, a question unanswered. Never end a scene with a resolved, peaceful conclusion.';
}

/** Scene-5 progression line, genre-aware (used in the scene-role lists). */
export function finalSceneProgression(genre: string): string {
  const style = endingStyleForGenre(genre);
  if (style === 'gentle') {
    return 'A consequence — the result of what came before, ending on a warm, funny, or gently curious beat that pulls viewers to the next episode';
  }
  if (style === 'uplifting') {
    return 'A consequence — the result of what came before, ending on an emotionally resonant beat that pulls viewers to the next episode';
  }
  return 'A consequence — the result of what came before, ending on an unresolved note or cliffhanger that pulls viewers to the next episode';
}

// Warmth/humor/hope/curiosity signals accepted for gentle/uplifting endings.
const GENTLE_ENDING_WORDS =
  /\b(hope|hopeful|hoping|smiles?|smiled|smiling|grins?|grinned|laugh(?:s|ed|ing)?|giggles?|chuckles?|warm(?:th|ed|ing)?|gentle|bright(?:er|est)?|glow(?:s|ed|ing)?|tomorrow|begin(?:s|ning)?|begins|started|first step|new (?:day|friend|adventure|world|home|beginning|plan|idea)|home|safe|friends?|friendship|promise[sd]?|invited?|welcomed?|discover(?:s|ed|y|ing)?|curious|wonder(?:s|ed|ing)?|delight(?:ed)?|proud|brave|bravery|kind(?:ness)?|gift|surprise[sd]?|cheer(?:s|ed|ing|ful)?|celebrat\w+|dream(?:s|ed|ing)?|wish(?:es|ed|ing)?|believ\w+|courage|love[sd]?|together|forgiv\w+|reunit\w+|healed?|healing)\b/i;

/**
 * Genre-aware ending validator. Tension genres require a strong cliffhanger;
 * gentle/uplifting genres also accept warm, humorous, hopeful, or curious
 * endings — so a kids/comedy scene is no longer force-rewritten into dread.
 */
export function isStrongGenreEnding(lastSentence: string, genre: string): boolean {
  if (!lastSentence || lastSentence.trim().length < 3) return false;
  if (isStrongCliffhanger(lastSentence)) return true;
  if (endingStyleForGenre(genre) === 'tension') return false;
  return GENTLE_ENDING_WORDS.test(lastSentence.trim());
}

/**
 * Semantic cliffhanger evaluation using a lightweight LLM call.
 * Only invoked when the deterministic `isStrongCliffhanger` check fails,
 * to confirm the failure is real (not a false negative).
 * Returns true if the LLM confirms the ending creates narrative tension.
 */
export async function evaluateCliffhangerSemantic(lastSentence: string, genre: string = ''): Promise<boolean> {
  if (!lastSentence || lastSentence.trim().length < 3) return false;
  const style = endingStyleForGenre(genre);
  const criterion =
    style === 'gentle'
      ? 'makes the viewer want to continue through warmth, humor, curiosity, or delight (not tension or dread)'
      : style === 'uplifting'
        ? 'makes the viewer want to continue through emotional resonance, hope, or heartfelt anticipation (not necessarily tension)'
        : 'creates genuine narrative tension that makes a viewer want to continue watching';
  const systemPrompt = `You evaluate whether a single sentence ends a scene effectively for a YouTube Shorts ${genre || 'story'} audience. Be strict — only pass sentences that genuinely make the viewer want to see what happens next. Return JSON only.`;
  const userPrompt = `Does this sentence end the scene in a way that ${criterion}?

"${lastSentence.slice(0, 300)}"

Respond with JSON only:
{
  "pass": true/false,
  "confidence": 0-100,
  "reason": "one short sentence explaining why"
}`;
  try {
    const raw = await generateWithMistral(systemPrompt, userPrompt, { stage: 'content', temperature: 0 });
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pass === 'boolean') {
      return parsed.pass;
    }
  } catch {
    // On parse failure, fall back to deterministic result
  }
  return isStrongGenreEnding(lastSentence, genre);
}

// ---------- Episode duration rebalancing ----------

/**
 * If the episode is far from the 110-140 word target, ask the worst-offender
 * scene to be rewritten with a tighter or fuller word count.
 */
async function rebalanceEpisodeDuration(
  scenes: string[],
  ctx: {
    storyTitle: string;
    genre: string;
    protagonistName: string;
    episodeNumber: number;
    synopsis: string;
    characterBible?: CharacterBible;
    // M31: pronoun consistency during rebalance rewrite
    protagonistGender?: 'male' | 'female' | 'neutral';
  },
  priorOpenings: string[] = []
): Promise<string[]> {
  // L4-WORD-COUNT (root-cause fix): the previous implementation
  // rewrote exactly ONE scene per call (the shortest or longest).
  // When the model produced scenes that were uniformly off-target
  // (e.g. all five scenes at 22 words when target is 28), expanding
  // just one scene to ~40 words lifted the total by 18 — but 4×22 +
  // 40 = 128 was still in band only by luck. When the off-target
  // pattern was more severe (e.g. all five at 18 words), the total
  // stayed at 110, and the second rebalance pass rewrote a DIFFERENT
  // scene, lifting the total to 130. Sometimes still not enough.
  //
  // The root cause is that 1-scene-at-a-time rebalance cannot
  // converge when N scenes need adjustment and the available
  // headroom per scene is < the total gap. The fix below rewrites
  // ALL off-target scenes in a single pass, computed by ranking
  // scenes by distance from the per-scene target and budgeting the
  // total target across the rewrites. The result converges in a
  // single pass instead of two — and if it doesn't, the outer
  // rebalanceScenesDuration loop calls again with the new totals.

  const total = scenes.reduce((s, t) => s + wordCount(t), 0);
  if (total >= targetEpisodeWordsMin && total <= targetEpisodeWordsMax) {
    return scenes;
  }

  const tooShort = total < targetEpisodeWordsMin;
  const counts = scenes.map((s) => wordCount(s));

  // L4-WORD-COUNT: rank scenes by distance from the per-scene
  // target. Scenes that are MOST off-target get rewritten first;
  // the budget is allocated by remaining gap. This converges faster
  // than picking one scene and hoping for the best.
  const perSceneTarget = targetWordsPerScene;
  const ranked = scenes
    .map((s, i) => ({
      idx: i,
      count: counts[i]!,
      distance: Math.abs(counts[i]! - perSceneTarget),
    }))
    .sort((a, b) => b.distance - a.distance);

  // Determine how many scenes need rewriting to bring the total
  // into band. If the total is too short by 24 words, rewriting
  // one scene to add 24 words works. If it's short by 60, we
  // need at least 2-3 scenes. Cap at 3 to bound the API spend.
  const gap = tooShort
    ? targetEpisodeWordsMin - total
    : total - targetEpisodeWordsMax;
  // Each rewrite can shift the count by at most ~15 words in either
  // direction (clamped by the rebalance's own min/max scene length).
  const scenesToRewrite = Math.min(3, Math.max(1, Math.ceil(gap / 15)));
  const targets = ranked.slice(0, scenesToRewrite);

  // Issue the rebalance rewrites in parallel. Each call asks the
  // model to tighten or expand a single scene to a target word
  // count that brings the overall total into band when combined
  // with the other unchanged scenes.
  // Per-rewrite budget: split the remaining gap evenly across the
  // rewritten scenes, then add the unchanged baseline.
  const rewrites = await Promise.all(
    targets.map(async (t) => {
      const currentCount = t.count;
      const targetForThisScene = tooShort
        ? Math.min(
            40,
            Math.max(
              perSceneTarget + 2,
              currentCount + Math.ceil(gap / scenesToRewrite)
            )
          )
        : Math.max(
            16,
            Math.min(
              perSceneTarget - 2,
              currentCount - Math.ceil(gap / scenesToRewrite)
            )
          );
      const directionLabel = tooShort
        ? `EXPAND to ~${targetForThisScene} words (add a vivid sensory detail without changing meaning).`
        : `TIGHTEN to ~${targetForThisScene} words (cut filler, keep the action and the emotional beat).`;

      const systemPrompt = `You are a human editor adjusting scene length for a narrated ${sanitizeForPrompt(ctx.genre)} story. Preserve the writer's voice and the scene's emotional beat. Cut or expand naturally — don't make it sound formulaic. Output prose only.`;

      const userPrompt = `Rewrite Scene ${t.idx + 1} of "${sanitizeForPrompt(ctx.storyTitle)}" Episode ${ctx.episodeNumber}.

Original scene: "${sanitizeForPrompt(scenes[t.idx])}"

${directionLabel}
Keep the same action and beat. Match ${sanitizeForPrompt(ctx.genre)} mood. Do not break continuity with the surrounding scenes.

${ctx.characterBible ? `Character: ${sanitizeForPrompt(ctx.protagonistName)} (${sanitizeForPrompt(ctx.characterBible.facialFeatures)})` : ''}
Pronouns for the protagonist: ${pronounsFor(ctx.protagonistGender).subject}/${pronounsFor(ctx.protagonistGender).object}/${pronounsFor(ctx.protagonistGender).possessive}. Use these pronouns EXACTLY — do not switch between pronouns mid-scene.

Output the rewritten scene only, no labels.`;

      try {
        const response = await generateWithMistral(systemPrompt, userPrompt);
        const cleaned = extractNarration(sanitizeAIResponse(response), t.idx + 1);
        if (cleaned.trim().split(/\s+/).filter(Boolean).length >= 3) {
          // BL-007: Validate rewritten scene against prior episode
          // openings to prevent introducing duplicate narration
          // during rebalance.
          if (priorOpenings.length > 0 && isSceneTooSimilar(cleaned, priorOpenings)) {
            logger.warn(
              { episodeNumber: ctx.episodeNumber, targetIdx: t.idx },
              'Rebalance produced scene too similar to prior episode — keeping original'
            );
            return { idx: t.idx, text: scenes[t.idx]! };
          }
          return { idx: t.idx, text: cleaned };
        }
      } catch (err) {
        logger.debug({ err, episodeNumber: ctx.episodeNumber, targetIdx: t.idx }, 'Rebalance pass failed for scene; keeping original');
      }
      return { idx: t.idx, text: scenes[t.idx]! };
    })
  );

  // Apply the rewrites and recompute the total. If the total is
  // still out of band after this pass, the outer
  // rebalanceScenesDuration loop will call us again (up to
  // REBALANCE_MAX_PASSES).
  const updated = scenes.slice();
  for (const r of rewrites) {
    updated[r.idx] = r.text;
  }
  return updated;
}

// ---------- Episode with full context ----------

/**
 * Build the system prompt, user prompt, and fallback metadata for episode meta generation.
 * Returns all four pieces needed to generate title/hook/synopsis/cliffhanger/episodeSummary.
 */
function buildEpisodeMetaPrompts(
  episodeNumber: number,
  storyTitle: string,
  genre: string,
  protagonistName: string,
  protagonistAge: string,
  setting: string,
  characterBible: EpisodeContext['characterBible'],
  previousEpisodeSummary: string | undefined,
  previousCliffhanger: string | undefined,
  avoidanceConstraints: string[],
  // L4-EP-TITLE: titles already used by earlier episodes in this story +
  // the story's own title. Surfaced in the prompt as a "DO NOT USE" list
  // so the model can avoid them on the first try instead of producing a
  // duplicate that has to be regenerated. Title uniqueness is then
  // enforced in generateEpisodeMetaWithRetry as a safety net.
  usedTitles: string[] = []
): {
  systemPrompt: string;
  userPrompt: string;
  titleFallbacks: Record<number, string>;
} {
  const characterContext = characterBible
    ? `
MAIN CHARACTER PROFILE:
- Name: ${protagonistName}
- Age: ${protagonistAge}
- Appearance: ${characterBible.facialFeatures}. ${characterBible.clothing}
- Speech/Style: ${characterBible.speechPatterns}
- Emotions to convey: ${characterBible.emotions.join(', ')}
- Physical mannerisms: ${characterBible.physicalMannerisms}
${characterBible.catchphrases.length > 0 ? `- Known phrases: ${characterBible.catchphrases.join(', ')}` : ''}
`
    : `
MAIN CHARACTER: ${protagonistName}, age ${protagonistAge}
`;

  const continuity =
    previousEpisodeSummary && previousCliffhanger
      ? `PREVIOUS EPISODE ENDED WITH: "${previousCliffhanger}"
PREVIOUS EPISODE SUMMARY: "${previousEpisodeSummary}"`
      : 'This is the FIRST episode of the story.';

  const constraintsBlock =
    avoidanceConstraints.length > 0
      ? `\nUNIQUENESS CONSTRAINTS (avoid reusing these from earlier stories in the catalogue):\n${avoidanceConstraints.map((c) => `- ${c}`).join('\n')}\n`
      : '';

  const systemPrompt = `You are a human story writer for ${genre} stories that will be narrated as YouTube Shorts. Write like a real person — not like an AI.

${formatGenreDirectiveForEpisode(genre)}

JSON OUTPUT RULES (apply strictly):
- Return ONLY a valid JSON object. No markdown code fences (\`\`\`json), no explanations, no prose outside the JSON.
- Every value must be a plain-text string wrapped in double quotes.
- Do NOT use markdown formatting inside values: no **bold**, no *italics*, no > blockquotes, no backticks, no bullet lists.

HOOK: Drops the viewer straight into a moment. A fragment of action or tension. Not an introduction — a doorway. Let it be as long as it needs to be — a single punchy line or a brief scene.

SYNOPSIS: Plain language telling what happens in this episode. Not a summary of themes — a taste of the action. 2-4 sentences, natural and direct.

CLIFFHANGER: The moment right before the break. A door cracking open. A question the viewer can't answer. A choice hanging in the air. 1-3 sentences.

TONE: ${genre} — warm and mysterious for fantasy, urgent for thriller, tender for romance, dread for horror, hopeful for inspirational.

WRITE NATURALLY: Don't count sentences. Don't use formulaic structures. Read it back — if it sounds like a template, rewrite it.

YOUTUBE MONETIZATION RULES:
- No graphic violence, gore, sexual content, slurs, or self-harm depiction.
- No drug/weapon glorification. No real-person impersonation.
- Suitable for a general YouTube Shorts audience.

ORIGINALITY: 100% original. Never reference any copyrighted franchise, character, or setting (no Ghibli, no Pokemon, no Marvel, no Disney, etc.).

TITLE RULES (apply strictly):
- Pick a unique title that does NOT duplicate the story title or any earlier episode title.
- Never prefix with "Episode N", "Chapter N", or "Part N" — the position in the series is conveyed by the order, not the title.
- Do NOT reuse the story title verbatim. The story's name is the parent; each episode is a distinct chapter with its own name.
- Keep it short (2-5 words) and evocative.
${usedTitles.length > 0 ? `- DO NOT USE any of these titles (already taken): ${usedTitles.map((t) => JSON.stringify(t)).join(', ')}` : ''}`;

  const userPrompt = `Write Episode ${episodeNumber} for "${sanitizeForPrompt(storyTitle)}" (${sanitizeForPrompt(genre)}).

${formatGenreDirectiveForEpisode(genre)}

SETTING: ${sanitizeForPrompt(setting)}
${characterContext}
${continuity}
${constraintsBlock}
Return ONLY this JSON object, nothing else. All five values must be plain-text strings wrapped in double quotes. Do not use markdown formatting (no **bold**, no *italics*, no code fences, no > blockquotes) inside any value. Do not add prose, explanations, or bullet lists outside the JSON.

{"title": "", "hook": "", "synopsis": "", "cliffhanger": "", "episodeSummary": ""}`;

  const titleFallbacks: Record<number, string> = {
    1: 'The Beginning',
    2: 'The Discovery',
    3: 'The Challenge',
    4: 'The Deepening',
    5: 'The Crisis',
    6: 'The Dark Night',
    7: 'The Turning Point',
    8: 'The Climax',
    9: 'The Revelation',
    10: 'A New Dawn',
  };

  return { systemPrompt, userPrompt, titleFallbacks };
}

/**
 * Check whether a generated title violates uniqueness rules. The rules are:
 *   1) case-insensitive equality with the story title,
 *   2) case-insensitive equality with any of `usedTitles`,
 *   3) the title CONTAINS the story title or any usedTitles entry as a
 *      leading substring (e.g. "The Undersky Chart: Episode 8 — ..." —
 *      the story title appears as a prefix; the result is broken-looking
 *      and confusing to readers who expect an independent chapter name),
 *   4) starts with the prefixes "Episode N", "Chapter N", or "Part N" (the
 *      model uses these to disambiguate when it can't think of a unique
 *      title — they look broken in the rendered list),
 *   5) empty or whitespace-only.
 *
 * Returns the reason string if the title is invalid, null if it is OK.
 * The string is suitable for embedding in a regeneration prompt that
 * asks the model to pick a different title.
 */
export function validateEpisodeTitle(
  title: string,
  storyTitle: string,
  usedTitles: string[]
): string | null {
  const trimmed = (title ?? '').trim();
  if (trimmed.length === 0) return 'Title is empty.';

  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const tn = norm(trimmed);
  const sn = norm(storyTitle);
  if (tn === sn) return `Title duplicates the story title "${storyTitle}".`;

  // Prefix-contains check: if the title starts with the story title (after
  // normalisation), the model has bolted the story title onto something else.
  // The production regression was "The Undersky Chart: Episode 8 — The Name
  // That Answers Back" — the story title is the leading phrase.
  if (sn.length > 0 && tn.startsWith(sn + ' ')) {
    return `Title contains the story title "${storyTitle}" as a leading phrase.`;
  }

  for (const u of usedTitles) {
    const un = norm(u);
    if (!un) continue;
    if (tn === un) return `Title duplicates an earlier episode title "${u}".`;
    if (tn.startsWith(un + ' ')) {
      return `Title contains an earlier episode title "${u}" as a leading phrase.`;
    }
  }

  // Reject "Episode N", "Chapter N", "Part N" prefixes (any number).
  if (/^(episode|chapter|part)\s+\d+/i.test(trimmed)) {
    return `Title uses a forbidden positional prefix (Episode/Chapter/Part N): "${trimmed}".`;
  }

  return null;
}

/**
 * Call the AI to generate episode meta (title, hook, synopsis, cliffhanger, summary).
 * Retries with exponential backoff; falls back to defaults on exhausted retries.
 *
 * L4-EP-TITLE: If a `usedTitles` list is provided (which always includes the
 * story title), the function rejects titles that duplicate any entry in the
 * list or that use a forbidden positional prefix, and re-prompts the model
 * up to TITLE_UNIQUE_RETRIES additional times to pick a fresh title. This
 * is the safety net for the prompt-level "DO NOT USE" list — if the model
 * ignores the instruction, we still ship a unique title.
 */
async function generateEpisodeMetaWithRetry(
  episodeNumber: number,
  systemPrompt: string,
  userPrompt: string,
  titleFallbacks: Record<number, string>,
  usedTitles: string[] = [],
  storyTitle: string = '',
  genre: string = ''
): Promise<{
  title: string;
  hook: string;
  synopsis: string;
  cliffhanger: string;
  episodeSummary: string;
}> {
  let title = titleFallbacks[episodeNumber] || `Story Beat ${episodeNumber}`;
  let hook = '';
  let synopsis = '';
  let cliffhanger = '';
  let episodeSummary = '';
  let lastMetaErr = '';

  for (let attempt = 0; attempt < META_MAX_RETRIES; attempt++) {
    try {
      const raw = await generateWithMistral(systemPrompt, userPrompt);
      const parsed = safeJsonParse<Partial<{
        title: string;
        hook: string;
        synopsis: string;
        cliffhanger: string;
        episodeSummary: string;
      }>>(raw);

      const pHook = typeof parsed.hook === 'string' && parsed.hook.trim().length > 0;
      const pSyn = typeof parsed.synopsis === 'string' && parsed.synopsis.trim().length > 0;
      const pCliff = typeof parsed.cliffhanger === 'string' && parsed.cliffhanger.trim().length > 0;
      const pSum = typeof parsed.episodeSummary === 'string' && parsed.episodeSummary.trim().length > 0;
      if (!pHook || !pSyn || !pCliff || !pSum) {
        throw new Error('Episode meta JSON missing required fields');
      }
      const candidateTitle = typeof parsed.title === 'string' && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : title;

      // Episode-level genre guard: the blueprint guard cannot see outlines, and
      // off-genre episodes shipped after clean blueprints (viral-trend episode 2
      // drifting into supernatural horror). Validate with high-precision
      // forbidden phrases only; on violation, retry with a correction note.
      if (genre) {
        const outlineText = [candidateTitle, parsed.hook, parsed.synopsis, parsed.cliffhanger].join('\n');
        const outlineViolations = validateEpisodeOutlineGenre(outlineText, genre);
        if (outlineViolations.length > 0) {
          logger.warn(
            { episodeNumber, genre, violations: outlineViolations, attempt: attempt + 1 },
            'Episode outline violates genre guard — regenerating with correction note'
          );
          userPrompt = `${userPrompt}\n\n${buildGenreGuardCorrectionNote(outlineViolations, genre)}`;
          throw new Error(`Episode outline off-genre: ${outlineViolations.join('; ')}`);
        }
      }

      title = candidateTitle;
      hook = parsed.hook!.trim();
      synopsis = parsed.synopsis!.trim();
      cliffhanger = parsed.cliffhanger!.trim();
      episodeSummary = parsed.episodeSummary!.trim();
      lastMetaErr = '';
      break;
    } catch (err) {
      lastMetaErr = err instanceof Error ? err.message : String(err);
      if (attempt === META_MAX_RETRIES - 1) {
        logger.warn({ episodeNumber, err: lastMetaErr }, 'Episode meta generation exhausted retries');
      } else {
        await logRetry('episode_meta', attempt + 1, META_MAX_RETRIES, lastMetaErr, undefined, String(episodeNumber));
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  // No low-quality template fallback: if every attempt failed, surface the
  // error so the episode/job regenerates instead of persisting the placeholder
  // "${name} discovers something extraordinary in ${setting}..." synopsis.
  if (!hook || !synopsis || !cliffhanger || !episodeSummary) {
    await logFallback('episode_meta', lastMetaErr, titleFallbacks[episodeNumber] || '', undefined, String(episodeNumber));
    throw new Error(
      `Episode ${episodeNumber} meta generation failed after ${META_MAX_RETRIES} attempts: ${lastMetaErr}`
    );
  }

  // L4-EP-TITLE: title-uniqueness safety net. The main loop above may have
  // produced a title that duplicates the story title or an earlier episode,
  // or that uses "Episode N" / "Chapter N" / "Part N" as a prefix. Re-prompt
  // the model with a focused regeneration message up to TITLE_UNIQUE_RETRIES
  // times. We send ONLY the title constraint — a single short turn — to
  // keep the cost of this safety net negligible.
  if (usedTitles.length > 0 || storyTitle) {
    for (let uniqueAttempt = 0; uniqueAttempt < TITLE_UNIQUE_RETRIES; uniqueAttempt++) {
      const violation = validateEpisodeTitle(title, storyTitle, usedTitles);
      if (!violation) break;
      logger.warn(
        { episodeNumber, title, violation, attempt: uniqueAttempt + 1 },
        'Episode title violates uniqueness — regenerating'
      );
      const regenPrompt = `Your previous title "${title}" is not allowed: ${violation}
The story is titled "${storyTitle}".
${usedTitles.length > 0 ? `Titles already used by other episodes in this story: ${usedTitles.map((t) => JSON.stringify(t)).join(', ')}` : ''}
Reply with ONLY a single valid JSON object: {"title": "<new unique title>"}
Constraints: 2-5 words, no positional prefix, no duplication.`;
      try {
        const raw = await generateWithMistral(
          'You are an editor enforcing strict title-uniqueness rules. Output JSON only.',
          regenPrompt
        );
        const parsed = safeJsonParse<{ title?: string }>(raw);
        if (parsed.title && parsed.title.trim()) {
          title = parsed.title.trim();
        }
      } catch (err) {
        logger.warn({ episodeNumber, err: String(err) }, 'Title-uniqueness regeneration failed; keeping current title');
        break;
      }
    }
    // Final fallback: if the title is still invalid after all retries, swap
    // in the per-episode titleFallback (which is always unique and short).
    const finalViolation = validateEpisodeTitle(title, storyTitle, usedTitles);
    if (finalViolation) {
      logger.warn(
        { episodeNumber, title, violation: finalViolation, fallback: titleFallbacks[episodeNumber] },
        'Episode title still violates uniqueness after retries — using fallback'
      );
      title = titleFallbacks[episodeNumber] || `Story Beat ${episodeNumber}`;
    }
  }

  return { title, hook, synopsis, cliffhanger, episodeSummary };
}

/**
 * Build the system prompt and scene progressions for batched scene generation.
 * Returns all the pieces needed to prompt for 5 scenes in a single call.
 */
function buildBatchScenesPrompt(
  episodeNumber: number,
  storyTitle: string,
  protagonistName: string,
  genre: string,
  synopsis: string,
  characterBible: EpisodeContext['characterBible'],
  protagonistGender: 'male' | 'female' | 'neutral' = 'neutral'
): { systemPrompt: string; userPrompt: string } {
  const sceneProgressions = [
    'Scene 1: Something shifts — a small action that sets things in motion',
    'Scene 2: A discovery or realization — the character sees, hears, or understands something new',
    'Scene 3: Movement or change — the character moves through space or makes a decision',
    'Scene 4: A complication — something (or someone) pushes back',
    `Scene 5: ${finalSceneProgression(genre)}`,
  ];

  const sceneWordTarget = targetWordsPerScene;

  const systemPrompt = `You are a human novelist writing a ${genre} story that will be narrated as a YouTube Shorts voiceover. Your prose is read aloud at ~145 words per minute. Write the way real novelists write — not like an AI.

PRONOUN CONSISTENCY: The user message specifies the protagonist's pronoun set (he/him/his, she/her/her, or they/them/their). Use those pronouns EXACTLY and consistently — never switch mid-scene, never default to a different set because the genre "feels" that way.

THE MOST IMPORTANT RULE: Every scene must sound like it was written by a person, not generated by a machine. Read each sentence back in your head. If it sounds stiff, formal, or formulaic, rewrite it.

WORD COUNT PER SCENE: Each scene should be ~${sceneWordTarget} words (range: ${Math.max(18, sceneWordTarget - 4)}–${sceneWordTarget + 6}). All 5 scenes together should total ${targetEpisodeWordsMin}-${targetEpisodeWordsMax} words. Hitting these targets on the first try avoids a costly re-pass — but never pad with filler or trim meaningful detail just to hit the number.

HOW REAL WRITERS WRITE:
- Sentence length varies naturally within a scene (some short, some long).
- Every sentence starts differently. Never let two consecutive sentences begin the same way (not with the same name, the same verb, or the same structure).
- Active verbs, specific nouns. Not "walked" — "slipped", "stumbled", "crept." Not "the thing" — "the rusted key", "the cracked mirror."
- Sensory details that land: the smell of wet stone, the weight of a coat, the sound of footsteps echoing.
- Contractions and fragments. People don't say "they are" — they say "they're." A one-word sentence like "Silence." can be more powerful than a full sentence.
- Avoid ANY transition words: however, therefore, moreover, furthermore, consequently, nonetheless, thus.
- Avoid ANY filler openings: Suddenly, All of a sudden, Without warning, In this scene, The scene opens with, Little did they know.

SCENE DIVERSITY — CRITICAL: Each of the 5 scenes must feel distinct. They should:
- Use different vocabulary and sentence structures
- Start with completely different opening phrases (no two scenes may share an opening)
- No two scenes across the episode should use the same verbs or sentence patterns
- Cover different actions, settings, and emotional beats
- Feel like 5 distinct moments in a story, not variations of the same beat

CROSS-EPISODE UNIQUENESS — CRITICAL: Every scene across the entire 10-episode story must have UNIQUE narration. Never reuse phrases, sentences, or sentence structures from scenes in earlier episodes. Each scene's text must be one-of-a-kind in the entire story. Before writing, scan the existing episodes' narration and avoid any phrasing that has been used before.

SENTENCE STRUCTURE — CRITICAL: Never write two sentences of similar length in a row. The sentence lengths within a single scene must be varied, not uniform. Check your scene after writing it — if any two consecutive sentences have the same word count, rewrite one.

${sceneEndingGuidance(genre).replace(/^- /, '')}

Stay in ${genre} mood. A fantasy scene feels different from a thriller scene.

No labels, no headings, no scene numbers in the output. Just the prose.

YOUTUBE MONETIZATION RULES:
- No graphic violence, gore, sexual content, slurs, or self-harm depiction.
- No drug or weapon glorification. No real-person impersonation.
- Themes appropriate for a YouTube Shorts general audience.
- 100% original. Never reference any copyrighted franchise, character, or setting.`;

  const charSection = characterBible
    ? `\nProtagonist: ${protagonistName}
Appearance: ${characterBible.facialFeatures}. ${characterBible.clothing}
Mannerisms: ${characterBible.physicalMannerisms}
Pronouns: ${pronounsFor(protagonistGender).subject}/${pronounsFor(protagonistGender).object}/${pronounsFor(protagonistGender).possessive}. Use these pronouns EXACTLY when referring to ${protagonistName} — do not switch between pronouns mid-scene.`
    : '';

  const userPrompt = `Generate ${scenesPerEpisode} connected scenes for Episode ${episodeNumber} of "${sanitizeForPrompt(storyTitle)}" (${sanitizeForPrompt(genre)}).

Episode synopsis: ${sanitizeForPrompt(synopsis)}${charSection}

Scene roles (write ONE paragraph per scene):
${sceneProgressions.map((p) => `  ${sanitizeForPrompt(p)}`).join('\n')}

Output ONLY a JSON array of exactly ${scenesPerEpisode} strings, one per scene, in order. Each string is the full prose paragraph for that scene.
Example format:
["Scene 1 prose...", "Scene 2 prose...", "Scene 3 prose...", "Scene 4 prose...", "Scene 5 prose..."]`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse a batch scenes response into individual scene strings.
 * Returns null if the response is not valid JSON or does not contain exactly scenesPerEpisode non-empty strings.
 */
export function parseBatchScenesResponse(raw: string, expectedCount: number): string[] | null {
  // First try: direct JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Second try: extract a JSON array from surrounding text
    // (models sometimes wrap the array in markdown or prose)
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const arr = JSON.parse(match[0]);
      if (!Array.isArray(arr)) return null;
      parsed = arr;
    } catch {
      return null;
    }
  }

  if (!Array.isArray(parsed)) return null;
  if (parsed.length !== expectedCount) return null;
  const scenes = parsed.map((s: unknown) => (typeof s === 'string' ? s.trim() : ''));
  if (scenes.some((s: string) => s.length < 8)) return null;
  return scenes;
}

/**
 * Generate all scenes for an episode in a single batched API call.
 * Falls back to individual per-scene generation for any scene that fails validation.
 * Returns an array of exactly scenesPerEpisode scene strings.
 */
async function generateBatchScenes(
  episodeNumber: number,
  storyTitle: string,
  protagonistName: string,
  genre: string,
  synopsis: string,
  characterBible: EpisodeContext['characterBible'],
  priorOpenings: string[],
  hook: string,
  protagonistGender: 'male' | 'female' | 'neutral'
): Promise<string[]> {
  const { systemPrompt, userPrompt } = buildBatchScenesPrompt(
    episodeNumber, storyTitle, protagonistName, genre, synopsis, characterBible, protagonistGender
  );

  let batchedScenes: string[] | null = null;

  // MEDIUM #36: try the batched call once. If any scene in the batch fails
  // validation, fall back immediately to per-scene generation rather than
  // burning the retry budget regenerating scenes that were already valid.
  // Per-scene generation has its own retry loop, so invalid scenes still get
  // multiple attempts while valid scenes are preserved.
  try {
    const response = await generateWithMistral(systemPrompt, userPrompt);
    batchedScenes = parseBatchScenesResponse(response, scenesPerEpisode);
    if (batchedScenes) {
      const allValid = batchedScenes.every((s, i) => {
        const validation = validateSceneQuality(s, hook, episodeNumber, i + 1, batchedScenes!.slice(0, i), priorOpenings, genre);
        return validation.valid;
      });
      if (allValid) {
        return batchedScenes;
      }
      logger.info(
        { episodeNumber },
        'Batch scene generation produced invalid scenes — falling back to per-scene generation'
      );
    }
  } catch {
    // Fall through to per-scene generation; individual scenes will retry.
  }

  // Fall back to per-scene generation for any scenes that failed.
  // First, determine which scenes are missing or invalid.
  const initialCount = batchedScenes?.length ?? 0;
  const scenes: string[] = [];
  for (let sceneNum = 1; sceneNum <= scenesPerEpisode; sceneNum++) {
    const batchIdx = sceneNum - 1;
    if (batchedScenes && batchIdx < initialCount) {
      const validation = validateSceneQuality(batchedScenes[batchIdx]!, hook, episodeNumber, sceneNum, scenes, priorOpenings, genre);
      if (validation.valid) {
        scenes.push(batchedScenes[batchIdx]!);
        continue;
      }
    }
    // Generate this single scene individually
    logger.info(
      { episodeNumber, sceneNum },
      'Batch scene failed validation — generating individually'
    );
    const scene = await generateSingleSceneWithRetry(
      sceneNum, episodeNumber, storyTitle, protagonistName, genre,
      synopsis, scenes[sceneNum - 2] ?? null, characterBible,
      priorOpenings, hook, protagonistGender, scenes
    );
    scenes.push(scene);
  }

  return scenes;
}

/**
 * Generate a single scene with retry and validation.
 */
async function generateSingleSceneWithRetry(
  sceneNum: number,
  episodeNumber: number,
  storyTitle: string,
  protagonistName: string,
  genre: string,
  synopsis: string,
  previousSceneSummary: string | null,
  characterBible: EpisodeContext['characterBible'],
  priorOpenings: string[],
  hook: string,
  protagonistGender: 'male' | 'female' | 'neutral',
  // M9: the scenes already accepted for THIS episode, so the within-episode
  // similarity check (validateSceneQuality's previousLocal) actually applies
  // on the per-scene fallback path. Previously hardcoded to [].
  previousLocal: string[] = []
): Promise<string> {
  let sceneText = '';
  let lastReason = '';

  for (let attempt = 0; attempt < SCENE_MAX_RETRIES; attempt++) {
    try {
      sceneText = await generateSingleScene(
        sceneNum, episodeNumber, storyTitle, protagonistName, genre,
        synopsis, previousSceneSummary, characterBible, false, undefined, protagonistGender
      );
      const validation = validateSceneQuality(sceneText, hook, episodeNumber, sceneNum, previousLocal, priorOpenings, genre);
      if (validation.valid) break;
      lastReason = validation.reason || 'unknown';

      if (attempt < SCENE_MAX_RETRIES - 1) {
        await logRetry(`scene_${sceneNum}`, attempt + 1, SCENE_MAX_RETRIES, lastReason, undefined, String(episodeNumber));
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastReason = 'api_error';
      if (attempt < SCENE_MAX_RETRIES - 1) {
        await logRetry(`scene_${sceneNum}`, attempt + 1, SCENE_MAX_RETRIES, errMsg, undefined, String(episodeNumber));
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  if (!sceneText || sceneText.length < 15) {
    sceneText = pickGenreFallback(genre, sceneNum, protagonistName, '', protagonistGender);
    await logFallback(
      `episode_${episodeNumber}_scene_${sceneNum}`,
      lastReason || 'max_retries_exceeded',
      `scene_${sceneNum}_fallback`,
      undefined,
      String(episodeNumber)
    );
  }

  return sceneText;
}

/**
 * Generate all scenes for an episode with validation and retry.
 * Uses batched generation (all scenes in one API call) to reduce total
 * provider calls from 50 to ~10 per full story. Falls back to per-scene
 * generation for any scene that fails validation.
 * Returns an array of exactly scenesPerEpisode scene strings.
 */
export async function generateScenesForEpisode(
  episodeNumber: number,
  storyTitle: string,
  protagonistName: string,
  genre: string,
  synopsis: string,
  characterBible: EpisodeContext['characterBible'],
  priorOpenings: string[],
  hook: string = '',
  protagonistGender: 'male' | 'female' | 'neutral' = 'neutral'
): Promise<string[]> {
  // Try batched generation first (reduces API calls from 5 to 1 per episode)
  const batched = await generateBatchScenes(
    episodeNumber, storyTitle, protagonistName, genre, synopsis,
    characterBible, priorOpenings, hook, protagonistGender
  );

  // Validate all scenes and set minimum length.
  // M11: use the genre/gender-aware fallback instead of one hardcoded string —
  // two short scenes in the same episode previously produced IDENTICAL
  // narration, and the same string recurred verbatim across episodes.
  for (let i = 0; i < batched.length; i++) {
    if (batched[i]!.length < 20) {
      batched[i] = pickGenreFallback(genre, i + 1, protagonistName, '', protagonistGender, episodeNumber - 1);
    }
  }

  return batched;
}

/**
 * Rebalance episode scenes toward the target word band (~50 s narration).
 * Up to REBALANCE_MAX_PASSES passes; soft-warns if still off-band after rebalancing.
 *
 * L4-WORD-COUNT: each pass previously rewrote exactly ONE scene (the
 * shortest or longest), which never converged when the model was
 * producing uniform-length scenes that were all off-target. We now
 * rewrite up to TOP_OFFENDER_COUNT scenes per pass, in order of
 * distance from the target. The pass also re-validates the total and
 * logs the result so the regression in the warning log is visible
 * even when no API call is made.
 */
export async function rebalanceScenesDuration(
  scenes: string[],
  episodeContext: {
    storyTitle: string;
    genre: string;
    protagonistName: string;
    episodeNumber: number;
    synopsis: string;
    characterBible?: EpisodeContext['characterBible'];
    // M31: pronoun consistency during rebalance
    protagonistGender?: 'male' | 'female' | 'neutral';
  },
  priorOpenings: string[] = []
): Promise<string[]> {
  let rebalanced = scenes;
  for (let i = 0; i < REBALANCE_MAX_PASSES; i++) {
    const total = rebalanced.reduce((s, t) => s + wordCount(t), 0);
    if (total >= targetEpisodeWordsMin && total <= targetEpisodeWordsMax) break;
    rebalanced = await rebalanceEpisodeDuration(rebalanced, {
      storyTitle: episodeContext.storyTitle,
      genre: episodeContext.genre,
      protagonistName: episodeContext.protagonistName,
      episodeNumber: episodeContext.episodeNumber,
      synopsis: episodeContext.synopsis,
      ...(episodeContext.characterBible !== undefined ? { characterBible: episodeContext.characterBible } : {}),
      ...(episodeContext.protagonistGender !== undefined ? { protagonistGender: episodeContext.protagonistGender } : {}),
    }, priorOpenings);
  }
  const finalTotal = rebalanced.reduce((s, t) => s + wordCount(t), 0);
  if (finalTotal < targetEpisodeWordsMin || finalTotal > targetEpisodeWordsMax) {
    logger.warn(
      {
        episodeNumber: episodeContext.episodeNumber,
        finalTotal,
        min: targetEpisodeWordsMin,
        max: targetEpisodeWordsMax,
        perScene: rebalanced.map((s) => wordCount(s)),
      },
      'Episode word count outside target band after rebalance'
    );
  }
  return rebalanced;
}

export async function generateEpisodeWithContext(
  context: EpisodeContext
): Promise<GeneratedEpisode> {
  const {
    episodeNumber,
    storyTitle,
    genre,
    protagonistName,
    protagonistAge,
    protagonistGender,
    setting,
    previousEpisodeSummary,
    previousCliffhanger,
    characterBible,
    priorOpenings = [],
    avoidanceConstraints = [],
    usedTitles = [],
  } = context;

  // 1. Build prompts
  const { systemPrompt, userPrompt, titleFallbacks } = buildEpisodeMetaPrompts(
    episodeNumber,
    storyTitle,
    genre,
    protagonistName,
    protagonistAge,
    setting,
    characterBible,
    previousEpisodeSummary,
    previousCliffhanger,
    avoidanceConstraints
  );

  // 2. Generate episode meta
  const { title, hook, synopsis, cliffhanger, episodeSummary } =
    await generateEpisodeMetaWithRetry(episodeNumber, systemPrompt, userPrompt, titleFallbacks, usedTitles, storyTitle, genre);

  // 3. Generate scenes
  // M8: Pass the actual hook string so validateSceneQuality can reject scenes
  // that are too similar to the hook. Previously hook='' was passed, making
  // the "too_similar_to_hook" rejection dead code.
  // M31: thread protagonistGender through for pronoun-consistent narration.
  const scenes = await generateScenesForEpisode(
    episodeNumber,
    storyTitle,
    protagonistName,
    genre,
    synopsis,
    characterBible,
    priorOpenings,
    hook,
    protagonistGender
  );

  // 4. Rebalance duration
  const rebalanced = await rebalanceScenesDuration(scenes, {
    storyTitle,
    genre,
    protagonistName,
    episodeNumber,
    synopsis,
    ...(characterBible !== undefined ? { characterBible } : {}),
    ...(protagonistGender !== undefined ? { protagonistGender } : {}),
  }, priorOpenings);

  return { title, hook, synopsis, scenes: rebalanced, cliffhanger, episodeSummary };
}

/**
 * Generate episode meta only (title, hook, synopsis, cliffhanger, episodeSummary).
 * Used for parallel batch meta generation — scenes are generated separately afterward.
 */
export async function generateEpisodeMetaOnly(
  context: Pick<EpisodeContext, 'episodeNumber' | 'storyTitle' | 'genre' | 'protagonistName' | 'protagonistAge' | 'setting' | 'previousEpisodeSummary' | 'previousCliffhanger' | 'characterBible' | 'avoidanceConstraints'> & {
    // L4-EP-TITLE: List of titles already chosen for prior episodes in this
    // story, plus the story's own title. The model is told to AVOID every
    // string here, and a post-generation validator rejects any match (with
    // a regeneration prompt). Without this list, the model frequently
    // duplicates the story title as Episode 7 ("The Undersky Chart") or
    // appends an "Episode N —" prefix to Episode 8.
    usedTitles?: string[];
  }
): Promise<{ title: string; hook: string; synopsis: string; cliffhanger: string; episodeSummary: string }> {
  const {
    episodeNumber,
    storyTitle,
    genre,
    protagonistName,
    protagonistAge,
    setting,
    previousEpisodeSummary,
    previousCliffhanger,
    characterBible,
    avoidanceConstraints = [],
    usedTitles = [],
  } = context;

  const { systemPrompt, userPrompt, titleFallbacks } = buildEpisodeMetaPrompts(
    episodeNumber,
    storyTitle,
    genre,
    protagonistName,
    protagonistAge,
    setting,
    characterBible,
    previousEpisodeSummary,
    previousCliffhanger,
    avoidanceConstraints
  );

  return generateEpisodeMetaWithRetry(episodeNumber, systemPrompt, userPrompt, titleFallbacks, usedTitles, storyTitle, genre);
}

// ---------- Story blueprint ----------

export async function generateStoryBlueprint(
  genre: string,
  seed?: string,
  avoidanceConstraints: string[] = [],
  avoidNames?: Set<string>
): Promise<StoryBlueprint> {
  const safeGenre = sanitizeForPrompt(genre);
  const safeSeed = seed ? sanitizeForPrompt(seed) : null;
  const safeConstraints = sanitizeArrayForPrompt(avoidanceConstraints);

  const constraintsBlock =
    safeConstraints.length > 0
      ? `\n\nUNIQUENESS CONSTRAINTS (avoid these elements seen in prior stories):\n${safeConstraints.map((c: string) => `- ${c}`).join('\n')}`
      : '';

  const systemPrompt = `You are a creative story architect specializing in original cinematic anime story content for YouTube Shorts.
Create memorable, copyright-safe original stories with:
- Relatable protagonists (ages 10-22, fitting the genre)
- Rich, evocative settings appropriate to the genre
- Themes consistent with the genre
- Clear narrative arcs suitable for 10 connected episodes
- Never reference any existing franchise, IP, or copyrighted character

${formatGenreDirective(safeGenre)}

YOUTUBE MONETIZATION RULES:
- No graphic violence, gore, sexual content, slurs, or self-harm depiction.
- No drug/weapon glorification. No real-person impersonation.
- Themes suitable for a general YouTube Shorts audience.`;

  const baseUserPrompt = safeSeed
    ? `Create a story based on this seed concept: "${safeSeed}"
Genre: ${safeGenre}
${formatGenreDirective(safeGenre)}
${constraintsBlock}

Return ONLY this JSON:
{
  "title": "A memorable 3-5 word title (no copyrighted IP)",
  "protagonistName": "An ORIGINAL name (NOT from any existing franchise)",
  "protagonistAge": "Age appropriate to the genre",
  "protagonistGender": "Exactly one of: male, female, neutral. Choose the gender that best matches the seed concept. If the seed is gender-neutral or ambiguous, use 'neutral'.",
  "setting": "The main location in 3-5 words",
  "theme": "Central emotional theme",
  "logline": "Compelling 1-2 sentence hook"
}`
    : `Create an original ${genre} story concept for cinematic YouTube Shorts.
${formatGenreDirective(safeGenre)}
${constraintsBlock}

Return ONLY this JSON:
{
  "title": "A memorable 3-5 word title (no copyrighted IP)",
  "protagonistName": "An ORIGINAL name (NOT from any existing franchise)",
  "protagonistAge": "Age appropriate to the genre",
  "protagonistGender": "Exactly one of: male, female, neutral. Pick the gender that fits the genre's conventions for a ${genre} story. Default to 'neutral' if uncertain.",
  "setting": "The main location in 3-5 words",
  "theme": "Central emotional theme",
  "logline": "Compelling 1-2 sentence hook"
}`;

  const nonEmpty = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const fullNameKey = (full: string): string => full.trim().toLowerCase().replace(/\s+/g, ' ');
  const normTitle = (t: string): string =>
    t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Deterministic name-collision guard: tracks protagonist names the model
  // proposed that collide with existing protagonists, and appends an exclusion
  // on the next attempt so the model is forced to pick a different name.
  const collidedNames: string[] = [];
  // Title-vs-seed guard: if the model echoes the seed as the title, force a
  // distinct title on the next attempt.
  let forceDistinctTitle = false;
  // Genre guard: tracks off-genre drift detected by the deterministic validator
  // and appends a corrective note on the next attempt.
  let guardViolations: string[] = [];
  let lastErr = '';

  // Pre-compute the full exclusion list from avoidNames so the model never
  // proposes a known colliding name on the first attempt.
  const knownAvoidedNames = avoidNames ? Array.from(avoidNames).map(fullNameKey) : [];

  const generateUniqueName = (): string => {
    const consonants = 'bcdfghjklmnprstvwy';
    const vowels = 'aeiou';
    for (let i = 0; i < 100; i++) {
      let name = '';
      const length = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < length; j++) {
        name += j % 2 === 0 ? consonants[Math.floor(Math.random() * consonants.length)] : vowels[Math.floor(Math.random() * vowels.length)];
      }
      name = name.charAt(0).toUpperCase() + name.slice(1);
      if (!avoidNames?.has(fullNameKey(name))) {
        return name;
      }
    }
    return `Hero${Date.now()}`;
  };

  for (let attempt = 0; attempt < BLUEPRINT_MAX_RETRIES; attempt++) {
    try {
      const notes: string[] = [];
      const nameExclusions = new Set([...knownAvoidedNames, ...collidedNames.map(fullNameKey)]);
      if (nameExclusions.size > 0) {
        const displayExclusions = Array.from(nameExclusions).map((name) =>
          name.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
        );
        const fallbackName = collidedNames.length > 0 ? generateUniqueName() : '';
        notes.push(
          `STRICT NAME RULE: Do NOT use any of these protagonist names (already taken in the catalogue; case-insensitive match): ${displayExclusions.join(', ')}. Choose a distinctly different, genre-fitting original name that is not on this list.` +
          (fallbackName ? ` If you cannot find a suitable name, you MUST use this guaranteed-unique name: "${fallbackName}".` : '')
        );
      }
      if (forceDistinctTitle) {
        notes.push(
          `STRICT TITLE RULE: The "title" must NOT repeat or paraphrase the seed concept verbatim. Create a short, evocative, DISTINCT title (2-5 words).`
        );
      }
      if (guardViolations.length > 0) {
        notes.push(buildGenreGuardCorrectionNote(guardViolations, safeGenre));
      }
      const userPrompt = notes.length > 0 ? `${baseUserPrompt}\n\n${notes.join('\n\n')}` : baseUserPrompt;
      const response = await generateWithMistral(systemPrompt, userPrompt, { stage: 'blueprint' });
      const parsed = safeJsonParse<Partial<StoryBlueprint>>(response);

      const title = nonEmpty(parsed.title);
      const protagonistName = nonEmpty(parsed.protagonistName);
      const setting = nonEmpty(parsed.setting);
      const theme = nonEmpty(parsed.theme);
      const logline = nonEmpty(parsed.logline);
      if (!title || !protagonistName || !setting || !theme || !logline) {
        throw new Error('Blueprint JSON missing required fields');
      }
      if (seed && normTitle(title) === normTitle(seed)) {
        forceDistinctTitle = true;
        throw new Error('Blueprint title echoes the seed; regenerating a distinct title');
      }
      // Full-name match only: blocking on the first token over-restricts as the
      // catalogue grows (different protagonists may share a first name). The
      // uniqueness intent is to avoid repeating the SAME protagonist, which is
      // exactly a full-name match (also enforced race-free at persist time).
      if (avoidNames && avoidNames.has(fullNameKey(protagonistName))) {
        collidedNames.push(protagonistName);
        if (attempt === BLUEPRINT_MAX_RETRIES - 1) {
          const uniqueName = generateUniqueName();
          const escapedName = protagonistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const titleReplaced = title.replace(new RegExp(escapedName, 'gi'), uniqueName);
          const loglineReplaced = logline.replace(new RegExp(escapedName, 'gi'), uniqueName);
          const blueprint: StoryBlueprint = {
            title: titleReplaced !== title && titleReplaced.length > 0 ? titleReplaced : title,
            protagonistName: uniqueName,
            protagonistAge: nonEmpty(parsed.protagonistAge) ?? 'unspecified',
            protagonistGender: normalizeGender(parsed.protagonistGender),
            setting,
            theme,
            logline: loglineReplaced !== logline && loglineReplaced.length > 0 ? loglineReplaced : logline,
          };
          const violations = validateBlueprintGenre(blueprint, safeGenre);
          if (violations.length === 0) {
            return blueprint;
          }
        }
        throw new Error(`Protagonist name "${protagonistName}" collides with an existing protagonist`);
      }

      const blueprint: StoryBlueprint = {
        title,
        protagonistName,
        protagonistAge: nonEmpty(parsed.protagonistAge) ?? 'unspecified',
        protagonistGender: normalizeGender(parsed.protagonistGender),
        setting,
        theme,
        logline,
      };

      const violations = validateBlueprintGenre(blueprint, safeGenre);
      if (violations.length > 0) {
        throw new GenreGuardViolationError(violations);
      }

      return blueprint;
    } catch (err) {
      if (isGenreGuardViolationError(err)) {
        guardViolations = err.violations;
      }
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt === BLUEPRINT_MAX_RETRIES - 1) break;
      await logRetry('story_planning', attempt + 1, BLUEPRINT_MAX_RETRIES, lastErr);
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
    }
  }

  // No low-quality template fallback: if every attempt failed (malformed JSON,
  // empty required fields, or persistent name collision), surface the error so
  // the job regenerates from a clean state instead of persisting placeholder
  // content like "Sora" / "friendship and adventure".
  await logFallback('story_planning', lastErr, seed || 'unknown');
  throw new Error(`Blueprint generation failed after ${BLUEPRINT_MAX_RETRIES} attempts: ${lastErr}`);
}

// ---------- Cross-episode deduplication (parallel-safe) ----------

/**
 * Post-generation cross-episode scene deduplication.
 *
 * Runs AFTER Promise.all completes in Pass 2. Scans every scene across all
 * episodes and replaces any scene that is too similar to a scene from another
 * episode with a genre-appropriate fallback. This restores the cross-episode
 * deduplication that was sacrificed when Pass 2 was parallelized.
 *
 * Returns a new array — does NOT mutate the input.
 */
export function deduplicateCrossEpisodeScenes(
  episodes: GeneratedEpisode[],
  genre: string,
  protagonistName: string,
  // M31: Pass protagonist gender through to the fallback picker so the
  // replacement scene uses the correct pronouns. Defaults to 'neutral'
  // for backward compatibility with existing call sites that don't yet
  // pass a gender.
  protagonistGender: 'male' | 'female' | 'neutral' = 'neutral'
): GeneratedEpisode[] {
  const result: GeneratedEpisode[] = episodes.map((ep) => ({ ...ep, scenes: [...ep.scenes] }));

  for (let epIdx = 0; epIdx < result.length; epIdx++) {
    // All scenes from episodes OTHER than the current one
    const otherScenes = result
      .filter((_, i) => i !== epIdx)
      .flatMap((e) => e.scenes);

    if (otherScenes.length === 0) continue;

    const newScenes = [...result[epIdx]!.scenes];
    let changed = false;

    for (let scIdx = 0; scIdx < newScenes.length; scIdx++) {
      if (isSceneTooSimilar(newScenes[scIdx]!, otherScenes)) {
        logger.warn(
          { episodeNumber: epIdx + 1, sceneNumber: scIdx + 1 },
          'Cross-episode duplicate detected — replacing with episode-unique fallback'
        );
        // M8: Uniqueness comes from rotating the fallback template by episode
        // index (pickGenreFallback's episodeIndex arg), NOT from prefixing the
        // episode title. The old `(Episode Title) ` tag leaked the title into
        // the persisted scene narration and the TTS voiceover (normalizeForTTS
        // only strips [brackets]), and it did not even guarantee uniqueness —
        // the identical fallback body still scored >0.6 full-scene similarity.
        // Distinct templates per episode produce genuinely different prose.
        // M10: The rotated fallback can ITSELF collide (pool of 5 templates,
        // (sceneNum + episodeIndex) % 5 repeats every 5 episodes). Re-check
        // the substitution and rotate further until unique (bounded loop).
        let replacement = pickGenreFallback(genre, scIdx + 1, protagonistName, '', protagonistGender, epIdx);
        for (let offset = 1; offset <= 5 && isSceneTooSimilar(replacement, otherScenes); offset++) {
          replacement = pickGenreFallback(genre, scIdx + 1, protagonistName, '', protagonistGender, epIdx + offset);
        }
        newScenes[scIdx] = replacement;
        changed = true;
      }
    }

    if (changed) {
      result[epIdx] = { ...result[epIdx]!, scenes: newScenes };
    }
  }

  return result;
}

// ---------- Per-genre fallback scenes ----------

/**
 * M31: Pronoun-aware fallback picker. Replaces the prior function that
 * hardcoded "her"/"she" in every template. Now every template uses
 * ${pronounSubj}/${pronounObj}/${pronounPoss} placeholders, which are
 * substituted from the protagonist's gender at the moment the fallback
 * is needed. The default for a missing/unknown gender is the neutral
 * "they" set, so the fallback never misgenders the protagonist.
 */
export function pickGenreFallback(
  genre: string,
  sceneNum: number,
  protagonistName: string,
  setting: string,
  protagonistGender: 'male' | 'female' | 'neutral' = 'neutral',
  // M8: rotate the template by episode so the same scene position in different
  // episodes yields genuinely different prose. This replaces the old
  // `(Episode Title) ` prefix, which leaked the title into persisted narration
  // and the TTS voiceover (normalizeForTTS only strips [brackets]).
  episodeIndex = 0
): string {
  const genreFallbacks = GENRE_FALLBACK_SCENES[genre.toLowerCase()] ?? GENRE_FALLBACK_SCENES.default;
  if (!genreFallbacks || genreFallbacks.length === 0) return `Scene ${sceneNum} in ${setting}.`;
  const idx = (sceneNum - 1 + episodeIndex) % genreFallbacks.length;
  const fallback = genreFallbacks[idx];
  if (!fallback) return `Scene ${sceneNum} in ${setting}.`;
  const p = pronounsFor(protagonistGender);
  // Templates use ${pronounSubj^} / ${pronounPoss^} to request a
  // CAPITALIZED first letter when the pronoun starts a sentence. The
  // caret is a template-only marker (not a real regex character) so we
  // substitute it after picking the correct pronoun.
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  return fallback
    .replace(/\$\{protagonistName\}/g, protagonistName)
    .replace(/\$\{setting\}/g, setting)
    .replace(/\$\{pronounSubj\^\}/g, cap(p.subject))
    .replace(/\$\{pronounPoss\^\}/g, cap(p.possessive))
    .replace(/\$\{pronounSubj\}/g, p.subject)
    .replace(/\$\{pronounObj\}/g, p.object)
    .replace(/\$\{pronounPoss\}/g, p.possessive)
    .replace(/\$\{pronounRefl\}/g, p.reflexive);
}

/**
 * M31: Genre fallback templates use pronoun placeholder tokens. Each
 * template was rewritten from a hardcoded gendered version. Every
 * occurrence of "her"/"she"/"hers" became ${pronounObj}/${pronounSubj}/
 * ${pronounPoss} respectively. Romance templates (which reference BOTH
 * the protagonist and a secondary character) are the only ones that keep
 * hardcoded "he"/"him"/"his" for the other character — those still parse
 * correctly because the LLM is told the protagonist's gender separately.
 */
const GENRE_FALLBACK_SCENES: Record<string, string[]> = {
  fantasy: [
    "${protagonistName} drives ${pronounObj} heel into the crumbling stone, and the floor gives way beneath ${pronounObj}. ${pronounSubj^} drops into blue darkness, landing hard on cold earth.",
    "${protagonistName} yanks the thread free from the altar crack, and a sound like a hundred bells shatters the silence. Light erupts from the wound.",
    "${protagonistName} slams both palms against the sealed door, and the ancient wood groans open. Wind howls through, carrying dust and distant voices.",
    "${protagonistName} grabs the spirit's translucent wrist, and cold floods ${pronounPoss} veins like ice water. The figure shudders, then solidifies beneath ${pronounPoss} grip.",
    "${protagonistName} rips the amulet from the altar, and the ground splits beneath ${pronounPoss} feet. ${pronounSubj^} slides into darkness, fingers clawing at stone walls.",
  ],
  horror: [
    "${protagonistName} tears the mask from the wall, and the room screams with black air. ${pronounSubj^} stumbles back, eyes burning from something that should not exist.",
    "${protagonistName} drives ${pronounPoss} knife into the shifting floor, and the wood bleeds red. Something beneath the boards writhes, grateful for the wound.",
    "${protagonistName} slams the door shut, and the hinges shriek as nails push up from the frame. ${pronounSubj^} pins it shut with ${pronounPoss} full weight, breathing hard.",
    "${protagonistName} rips the hanging chains from the ceiling, and they crash down like falling bridges. Metal rattles across stone, waking what slept below.",
    "${protagonistName} pours the salt line across the threshold, and the air on the other side goes white. ${pronounSubj^} steps back as shapes press against the fog.",
  ],
  adventure: [
    "${protagonistName} wrenches the compass from the captain's cold hand, and the needle spins wildly before stopping at a direction ${pronounSubj} cannot name.",
    "${protagonistName} kicks the locked hatch open, and saltwater rushes in. ${pronounSubj^} dives beneath the rising water, fighting toward the light above.",
    "${protagonistName} rips the map free from the crumbling hull, and wind tears it from ${pronounPoss} grip. ${pronounSubj^} chases it across the rocking deck, laughing.",
    "${protagonistName} hauls ${pronounRefl} up the rope ladder as the ship lurches beneath ${pronounObj}. Salt spray stings ${pronounPoss} eyes as ${pronounSubj} climbs toward the crow's nest.",
    "${protagonistName} forces the iron key into the rusted lock, and the mechanism grinds open with a sound like breaking teeth. ${pronounSubj^} pulls the door wide.",
  ],
  mystery: [
    "${protagonistName} rips the cloth from the evidence table, and photographs scatter across the floor like fallen leaves. ${pronounSubj^} drops to ${pronounPoss} knees, sorting through faces.",
    "${protagonistName} smashes through the locked cabinet with ${pronounPoss} elbow, glass raining down. ${pronounSubj^} reaches through the shards, fingers closing around the hidden drive.",
    "${protagonistName} tears the wallpaper layer by layer, revealing carved grooves beneath. ${pronounSubj^} traces the scratched words with bleeding fingertips.",
    "${protagonistName} upends the urn, and ash pours across the floor along with a metal key. ${pronounSubj^} snatches it before the wind scatters the ash.",
    "${protagonistName} shoves the bookshelf aside, revealing a hidden door behind. ${pronounSubj^} slams ${pronounPoss} shoulder into it until the wood splinters inward.",
  ],
  'sci-fi': [
    "${protagonistName} jacks the neural cable into ${pronounPoss} temple, and data floods ${pronounPoss} vision like lightning through water. ${pronounSubj^} gasps as memories not ${pronounPoss} own crash through.",
    "${protagonistName} slams the reboot sequence, and the ship's walls flicker between dead black and blinding white. ${pronounSubj^} braces against the hull as reality restarts.",
    "${protagonistName} tears the damaged panel off the wall, revealing frayed wires beneath. ${pronounSubj^} shorts them together with ${pronounPoss} bare hands, feeling sparks race up ${pronounPoss} arms.",
    "${protagonistName} launches ${pronounRefl} through the cracked viewport, and vacuum pulls at ${pronounPoss} suit. ${pronounSubj^} propels toward the rescue craft, trailing fire behind ${pronounObj}.",
    "${protagonistName} smashes ${pronounPoss} fist through the hologram, shattering light into a thousand pieces. ${pronounSubj^} steps through the fragments, leaving the illusion behind.",
  ],
  thriller: [
    "${protagonistName} kicks the back door shut and locks it twice. ${pronounPoss^} phone buzzes with an unknown number. ${pronounSubj^} doesn't answer.",
    "${protagonistName} sprints across the rooftop as the helicopter spotlight sweeps past. ${pronounSubj^} drops behind the air-vent and counts ${pronounPoss} breath.",
    "${protagonistName} shoves the burner phone into the storm drain. The water carries it away, and ${pronounSubj} walks the other direction without looking back.",
    "${protagonistName} pulls the wire from the doorframe, hands steady. The light blinks green. ${pronounSubj^} lets ${pronounRefl} breathe for the first time in an hour.",
    "${protagonistName} hits the brake and the car skids sideways across wet asphalt. Headlights bloom in the rain. ${pronounSubj^} stares straight at them.",
  ],
  romance: [
    "${protagonistName} reaches out and brushes a petal from his hair. ${pronounPoss^} hand stays a moment longer than it has to. Neither of them speaks.",
    "${protagonistName} leans against the door of the train carriage. He's already on the platform. The whistle blows. ${pronounSubj^} doesn't move.",
    "${protagonistName} folds the letter with shaking hands. Outside, snow begins to fall. ${pronounSubj^} slides the envelope under his door and walks away fast.",
    "${protagonistName} laughs at something he says, surprising ${pronounRefl}. He looks at ${pronounObj} like he's never seen ${pronounObj} before, and maybe he hasn't.",
    "${protagonistName} catches his wrist as he turns to leave. He stops without looking back. ${pronounSubj^} doesn't let go.",
  ],
  default: [
    "${protagonistName} steps forward into ${setting}, drawn by something only ${pronounSubj} can hear. The world holds its breath around ${pronounObj}.",
    "${protagonistName} reaches for the truth and finds it warmer than expected. Everything ${pronounSubj} thought ${pronounSubj} knew bends slightly, then breaks.",
    "${protagonistName} pushes deeper into ${setting}, footsteps muffled by something soft underfoot. The path narrows. The light dims.",
    "${protagonistName} stops at the edge of what ${pronounSubj} understands. Below ${pronounObj}, something moves. Above ${pronounObj}, something watches.",
    "${protagonistName} breathes once, twice, and chooses. The choice cannot be unmade. The next step belongs to a different person.",
  ],
};
