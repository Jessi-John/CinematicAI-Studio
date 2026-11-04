/**
 * Genre Guard
 *
 * Deterministic post-generation validation for story blueprints. Catches obvious
 * genre drift before the story is persisted and triggers a retry with a
 * corrective prompt. This is a safety net under the prompt-level genre
 * directives; it never replaces them, but it makes the system self-healing when
 * the LLM ignores the genre instructions.
 */

import type { Genre } from '../services/types.js';
import type { StoryBlueprint } from './episode-generator.js';

export interface GenreGuardRule {
  /** Case-insensitive phrases that must NOT appear in the blueprint concept. */
  forbidden: string[];
  /** Case-insensitive phrases of which at least requiredCount must appear. */
  required: string[];
  /** Minimum number of required phrases that must be present (default 0). */
  requiredCount: number;
  /** Human-readable guidance appended to the retry note. */
  guidance: string;
}

export const GENRE_GUARD_RULES: Record<Genre, GenreGuardRule> = {
  fantasy: {
    forbidden: ['spaceship', 'space station', 'alien', 'robot', 'ai ', 'artificial intelligence'],
    required: ['magic', 'magical', 'enchant', 'spell', 'myth', 'curse', 'ancient', 'wonder', 'fantastical'],
    requiredCount: 0,
    guidance: 'Fantasy needs a magical or mythic element.',
  },
  adventure: {
    forbidden: ['haunt', 'cursed object', 'serial killer'],
    required: ['journey', 'quest', 'explore', 'discover', 'road', 'map', 'trail', 'expedition', 'voyage', 'uncharted'],
    requiredCount: 0,
    guidance: 'Adventure needs exploration, travel, or discovery.',
  },
  romance: {
    forbidden: ['ghost', 'phantom', 'curse', 'dread', 'horror', 'nightmare', 'serial killer', 'possess'],
    required: ['love', 'heart', 'romance', 'relationship', 'crush', 'fall for', 'together', 'affection', 'longing', 'intimacy', 'love interest', 'soulmate', 'date', 'kiss'],
    requiredCount: 1,
    guidance: 'Romance must be driven by a love relationship or romantic connection. Use a love interest, not a mystery or phenomenon.',
  },
  horror: {
    forbidden: ['comedy', 'funny', 'romantic comedy', 'laugh'],
    required: ['fear', 'dread', 'terror', 'haunt', 'curse', 'ghost', 'monster', 'shadow', 'dark', 'scream', 'nightmare'],
    requiredCount: 0,
    guidance: 'Horror needs fear, dread, or a threatening presence.',
  },
  mystery: {
    forbidden: ['magic', 'magical', 'supernatural', 'ghost', 'haunt', 'curse', 'demon'], // pure mystery should be solvable
    required: ['clue', 'puzzle', 'investigate', 'detective', 'secret', 'disappearance', 'crime', 'witness', 'truth', 'solve'],
    requiredCount: 0,
    guidance: 'Mystery needs a puzzle or investigation to solve.',
  },
  thriller: {
    forbidden: ['magic', 'magical', 'supernatural', 'ghost', 'curse', 'demon'],
    required: ['chase', 'race', 'deadline', 'threat', 'conspiracy', 'assassin', 'escape', 'trap', 'surveillance', 'hostage'],
    requiredCount: 0,
    guidance: 'Thriller needs immediate danger, suspense, or a ticking clock.',
  },
  'sci-fi': {
    forbidden: ['magic', 'magical', 'enchant', 'spell', 'curse', 'ghost'],
    required: ['technology', 'future', 'space', 'robot', 'ai', 'artificial intelligence', 'machine', 'cyber', 'spacecraft', 'distant future', 'quantum', 'genetic', 'network', 'simulation'],
    requiredCount: 0,
    guidance: 'Science fiction needs technology, space, or speculative science.',
  },
  drama: {
    forbidden: [
      'magic', 'magical', 'enchant', 'spell', 'curse', 'cursed', 'ghost', 'phantom',
      'portal', 'parallel world', 'dimensional', 'impossible', 'supernatural',
      'mysterious door', 'staircase that', 'door that shouldn', 'strange light',
    ],
    required: [],
    requiredCount: 0,
    guidance: 'Drama must be grounded human conflict. No magic, curses, ghosts, portals, impossible phenomena, or supernatural doors.',
  },
  comedy: {
    forbidden: [
      'ghost', 'phantom', 'curse', 'cursed', 'dread', 'horror', 'nightmare', 'terrifying',
      'supernatural', 'paranormal', 'eerie', 'ominous', 'haunt', 'possess',
      'serial killer', 'murder', 'blood', 'corpse', 'doom', 'apocalypse',
    ],
    required: ['funny', 'comedy', 'humor', 'joke', 'prank', 'mishap', 'misunderstanding', 'awkward', 'ridiculous', 'silly', 'chaos', 'competition', 'rivalry', 'embarrassing', 'hilarious', 'laugh', 'scheme', 'escalate'],
    requiredCount: 0,
    guidance: 'Comedy needs humor, mishaps, or witty situations. No horror, dread, ghosts, curses, or supernatural threats.',
  },
  action: {
    forbidden: ['magic', 'magical', 'enchant', 'ghost'],
    required: ['fight', 'chase', 'battle', 'escape', 'rescue', 'combat', 'explosion', 'pursuit', 'showdown', 'duel', 'heist', 'crash'],
    requiredCount: 0,
    guidance: 'Action needs physical conflict, chases, or combat.',
  },
  emotional: {
    forbidden: ['horror', 'terror', 'serial killer'],
    required: ['grief', 'love', 'loss', 'hope', 'memory', 'healing', 'family', 'friendship', 'regret', 'forgiveness', 'longing', 'connection', 'heart'],
    requiredCount: 0,
    guidance: 'Emotional stories need deep feeling and human connection.',
  },
  mythology: {
    forbidden: ['robot', 'ai ', 'artificial intelligence', 'spaceship'],
    required: ['god', 'goddess', 'myth', 'legend', 'fate', 'destiny', 'prophecy', 'ancient', 'temple', 'oracle', 'underworld', 'pantheon', 'hero', 'sacrifice'],
    requiredCount: 0,
    guidance: 'Mythology needs mythic, legendary, or divine elements.',
  },
  historical: {
    forbidden: ['magic', 'magical', 'robot', 'ai ', 'spaceship', 'time travel'],
    required: ['era', 'period', 'century', 'empire', 'kingdom', 'war', 'revolution', 'invention', 'tradition', 'dynasty', 'historical'],
    requiredCount: 0,
    guidance: 'Historical fiction needs a recognizable past era and period detail.',
  },
  'slice-of-life': {
    forbidden: [
      'magic', 'magical', 'enchant', 'spell', 'curse', 'cursed', 'ghost', 'phantom',
      'portal', 'parallel world', 'dimensional', 'supernatural', 'impossible',
      'mysterious door', 'staircase that', 'door that shouldn', 'strange light',
      'haunt', 'prophecy', 'doom', 'apocalypse', 'save the world', 'world-ending',
    ],
    required: ['ordinary', 'everyday', 'routine', 'friendship', 'family', 'school', 'neighborhood', 'workplace', 'small', 'quiet', 'gentle', 'lunch', 'home', 'garden', 'memory', 'neighbor', 'childhood'],
    requiredCount: 0,
    guidance: 'Slice-of-life needs ordinary daily life and small emotional stakes. No magic, ghosts, portals, curses, impossible phenomena, or world-saving stakes.',
  },
  'dark-fantasy': {
    forbidden: ['robot', 'ai ', 'spaceship', 'alien'],
    required: ['magic', 'magical', 'curse', 'dark', 'corrupt', 'grim', 'shadow', 'ancient', 'forbidden', 'blood', 'ruin', 'rot', 'doom'],
    requiredCount: 0,
    guidance: 'Dark fantasy needs grim, dangerous, or corrupted magic.',
  },
  psychological: {
    forbidden: ['magic', 'magical', 'enchant', 'spell'],
    required: ['mind', 'memory', 'dream', 'obsession', 'paranoia', 'identity', 'delusion', 'guilt', 'perception', 'unreliable', 'isolation', 'trauma'],
    requiredCount: 0,
    guidance: 'Psychological stories need mental conflict or distorted perception.',
  },
  inspirational: {
    forbidden: ['horror', 'terror', 'dread', 'curse', 'haunt'],
    required: ['hope', 'overcome', 'courage', 'dream', 'perseverance', 'kindness', 'growth', 'healing', 'uplift', 'inspire', 'second chance', 'believe'],
    requiredCount: 0,
    guidance: 'Inspirational stories need hope, overcoming, or personal growth.',
  },
  kids: {
    forbidden: ['horror', 'terror', 'dread', 'blood', 'murder', 'curse', 'death', 'romance', 'love interest', 'dating', 'kiss'],
    required: ['friend', 'adventure', 'wonder', 'discovery', 'pet', 'school', 'backyard', 'treehouse', 'play', 'curiosity', 'imagination', 'kindness'],
    requiredCount: 0,
    guidance: 'Kids stories need child-friendly wonder, friendship, or gentle adventure.',
  },
  survival: {
    forbidden: ['magic', 'magical', 'enchant', 'ghost', 'romance'],
    required: ['wilderness', 'desert', 'flood', 'storm', 'disaster', 'stranded', 'escape', 'cold', 'hunger', 'thirst', 'injury', 'shelter', 'fire', 'rescue'],
    requiredCount: 0,
    guidance: 'Survival needs a hostile environment and endurance.',
  },
  'anime-style': {
    forbidden: ['horror', 'serial killer', 'gore'],
    required: ['friendship', 'dream', 'determination', 'cherry', 'school', 'festival', 'stylized', 'emotion', 'visual', 'symbolism', 'coming-of-age', 'connection'],
    requiredCount: 0,
    guidance: 'Anime-style stories need emotional intensity, stylized settings, and coming-of-age themes.',
  },
  'viral-trend': {
    // Horror markers are forbidden at the blueprint level: the genre directive
    // previously romanticized "uncanny" hooks and blueprints drifted into
    // supernatural horror that passed the old guard.
    forbidden: ['magic', 'magical', 'enchant', 'century', 'empire', 'kingdom', 'haunt', 'ghost', 'curse', 'blood', 'dread', 'possess', 'supernatural', 'corpse', 'demon'],
    // The genre's DEFINING elements — a modern, shareable, internet-driven hook.
    // requiredCount: 1 makes this enforceable; previously 0, which let a viral-trend
    // story ship with zero virality elements (a plain supernatural mystery scored 92/A).
    required: ['viral', 'trend', 'social media', 'video', 'share', 'record', 'phone', 'app', 'screen', 'online', 'internet', 'followers', 'views', 'post', 'upload', 'livestream', 'camera', 'hashtag'],
    requiredCount: 1,
    guidance: 'Viral-trend needs a modern, relatable, shareable hook.',
  },
};

const GUARD_FIELDS: Array<keyof Pick<StoryBlueprint, 'title' | 'setting' | 'theme' | 'logline'>> = [
  'title',
  'setting',
  'theme',
  'logline',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const n = normalize(text);
  return n.length > 0 ? n.split(' ') : [];
}

// Inflection handling: a forbidden/required word must match its common
// morphological variants ('robot' → 'robots', 'curse' → 'cursed'/'cursing',
// 'magic' → 'magical') — but NEVER substrings of unrelated words ('ai' must
// not match 'said', 'again', 'villain'). Expansion is deterministic: forms are
// generated from the phrase and matched as whole words only.
const PLURAL_SUFFIXES = ['s', 'es'] as const;
const INFLECTION_SUFFIXES = ['s', 'es', 'd', 'ed', 'ing', 'ly', 'al', 'ion', 'tion', 'ship'] as const;

function expandWord(word: string): Set<string> {
  const forms = new Set<string>([word]);
  if (word.length >= 2) {
    for (const s of PLURAL_SUFFIXES) forms.add(word + s);
  }
  if (word.length >= 4) {
    for (const s of INFLECTION_SUFFIXES) forms.add(word + s);
    if (word.endsWith('e')) {
      // 'curse' → 'cursing'/'cursed'/'curses' (dropped-e inflections)
      const stem = word.slice(0, -1);
      forms.add(`${stem}ing`);
      forms.add(`${stem}ed`);
      forms.add(`${stem}es`);
    }
  }
  return forms;
}

/**
 * Word-aware phrase matching. A phrase matches when its normalized word
 * sequence appears as consecutive whole words in the text; the final word also
 * matches its inflections. Raw substring matching is never used — this is what
 * permanently prevents false rejections like 'ai ' matching 'said'/'again'
 * (the mythology/dark-fantasy blueprint retry-storm bug).
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const textWords = tokenize(text);
  const phraseWords = tokenize(phrase);
  if (phraseWords.length === 0 || textWords.length < phraseWords.length) return false;
  const lastForms = expandWord(phraseWords[phraseWords.length - 1]!);
  const window = phraseWords.length;
  for (let i = 0; i + window <= textWords.length; i++) {
    let ok = true;
    for (let j = 0; j < window - 1; j++) {
      if (textWords[i + j] !== phraseWords[j]) {
        ok = false;
        break;
      }
    }
    if (ok && lastForms.has(textWords[i + window - 1]!)) return true;
  }
  return false;
}

function anyFieldContains(blueprint: StoryBlueprint, phrase: string): boolean {
  const text = GUARD_FIELDS.map((f) => blueprint[f] ?? '').join(' ');
  return containsPhrase(text, phrase);
}

/**
 * Validate a story blueprint against deterministic genre rules.
 * Returns a list of human-readable violations. An empty array means the
 * blueprint passed the guard.
 */
export function validateBlueprintGenre(blueprint: StoryBlueprint, genre: string): string[] {
  const normalized = genre.toLowerCase() as Genre;
  const rule = GENRE_GUARD_RULES[normalized];
  if (!rule) return [];

  const violations: string[] = [];
  const conceptText = GUARD_FIELDS.map((f) => blueprint[f] ?? '').join('\n');

  for (const phrase of rule.forbidden) {
    if (anyFieldContains(blueprint, phrase)) {
      violations.push(`Forbidden for ${genre}: "${phrase}" found in concept.`);
    }
  }

  if (rule.requiredCount > 0 && rule.required.length > 0) {
    const found = rule.required.filter((phrase) => containsPhrase(conceptText, phrase));
    if (found.length < rule.requiredCount) {
      violations.push(
        `Missing required ${genre} element: concept should include at least one of [${rule.required.join(', ')}].`
      );
    }
  }

  return violations;
}

/**
 * Build a retry note that explains the genre violations and how to fix them.
 */
export function buildGenreGuardCorrectionNote(violations: string[], genre: string): string {
  const rule = GENRE_GUARD_RULES[genre.toLowerCase() as Genre];
  const lines = [
    'STRICT GENRE CORRECTION (the previous attempt drifted off-genre):',
    ...violations.map((v) => `- ${v}`),
    `Guidance: ${rule?.guidance ?? 'Stay true to the genre definition.'}`,
    'Rewrite the concept so it follows the REQUIRED ELEMENTS and avoids every FORBIDDEN ELEMENT listed in the genre directive above.',
  ];
  return lines.join('\n');
}

export class GenreGuardViolationError extends Error {
  violations: string[];
  constructor(violations: string[]) {
    super(`Genre guard rejected blueprint: ${violations.join('; ')}`);
    this.violations = violations;
  }
}

export function isGenreGuardViolationError(err: unknown): err is GenreGuardViolationError {
  return err instanceof GenreGuardViolationError;
}

// Episode-outline enforcement: the blueprint-level guard cannot see episode
// outlines, and stories whose blueprint passed still drifted off-genre at
// episode level (e.g. a viral-trend story whose episode 2 became supernatural
// horror). To make episode-level checking safe, only HIGH-PRECISION forbidden
// phrases are enforced — unambiguous supernatural/gore/tech markers that are
// never used innocently ('impossible', 'dread', 'haunting melody' etc. stay
// legal). A genre's episode-forbidden list is its blueprint forbidden list
// intersected with this set.
const EPISODE_PRECISION_FORBIDDEN = new Set([
  'magic', 'magical', 'enchant', 'spell', 'curse', 'cursed', 'ghost', 'phantom',
  'portal', 'parallel world', 'supernatural', 'robot', 'spaceship', 'alien',
  'artificial intelligence', 'serial killer', 'corpse', 'demon', 'gore',
  'time travel', 'blood', 'murder',
]);

/**
 * Validate a free-text episode outline (title/hook/synopsis/cliffhanger)
 * against the genre's high-precision forbidden phrases. Empty array = pass.
 */
export function validateEpisodeOutlineGenre(text: string, genre: string): string[] {
  const rule = GENRE_GUARD_RULES[genre.toLowerCase() as Genre];
  if (!rule) return [];
  return rule.forbidden
    .filter((phrase) => EPISODE_PRECISION_FORBIDDEN.has(normalize(phrase)) && containsPhrase(text, phrase))
    .map((phrase) => `Forbidden for ${genre}: "${phrase}" found in episode outline.`);
}
