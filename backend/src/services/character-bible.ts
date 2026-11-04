import { generateWithMistral } from '../lib/ai-client.js';
import { safeJsonParse } from '../lib/sanitize.js';
import { sanitizeForPrompt } from '../lib/sanitize-prompt.js';
import { logger } from './logger.js';
import { logFallback } from './generation-logger.js';

export interface CharacterBible {
  speechPatterns: string;
  clothing: string;
  facialFeatures: string;
  emotions: string[];
  relationships: Record<string, string>;
  catchphrases: string[];
  physicalMannerisms: string;
  // M31: Protagonist gender, returned by the character-bible AI. The
  // Stage-3 caller passes this into ctx.blueprint.protagonistGender (or
  // confirms the blueprint's choice when the LLM disagrees). Scene
  // narration then uses the pronoun set derived from this value to keep
  // the protagonist's pronouns consistent across every scene.
  // REQUIRED — every code path that constructs a CharacterBible must
  // include gender. TypeScript will flag omission at compile time.
  gender: 'male' | 'female' | 'neutral';
}

export interface CharacterBibleInput {
  name: string;
  genre: string;
  setting: string;
  role: 'protagonist' | 'supporting' | 'antagonist';
  // M31: optional seed gender for the AI. The AI may disagree (and
  // should be allowed to when the seed is ambiguous); the final value
  // is whichever the AI returns, normalized via normalizeGender.
  seedGender?: 'male' | 'female' | 'neutral';
  // L4-CHAR-ROLE: optional user-typed seed text. The bible prompt now
  // echoes the seed as a "ROLE HINT" so the AI commits to the
  // protagonist's narrative role (cartographer, thief, scholar, ...)
  // instead of inventing a parallel supporting character with the
  // same role. The production regression was a seed that cast the
  // protagonist as a cartographer, and Stage 3 also created a
  // "Lirael, a young cartographer" supporting character — two
  // cartographers in the same story.
  seed?: string;
}

const ROLE_UNIQUE_RETRIES = 3;

// Deterministic blocklist of protagonist roles and their close synonyms.
// The validator expands this map when the seed matches one of the keys.
const ROLE_SYNONYMS: Record<string, string[]> = {
  cartographer: ['cartographer', 'cartography', 'mapmaker', 'map maker', 'chart maker', 'surveyor', 'mapmaking'],
  mapmaker: ['cartographer', 'mapmaker', 'map maker', 'chart maker', 'surveyor'],
  thief: ['thief', 'robber', 'burglar', 'pickpocket', 'bandit', 'outlaw', 'pilferer', 'criminal'],
  scholar: ['scholar', 'academic', 'researcher', 'historian', 'learned person', 'student', 'philosopher'],
  warrior: ['warrior', 'soldier', 'fighter', 'knight', 'mercenary', 'guard', 'champion', 'combatant'],
  mage: ['mage', 'wizard', 'sorcerer', 'witch', 'warlock', 'spellcaster', 'magician', 'enchanter'],
  detective: ['detective', 'investigator', 'sleuth', 'private eye', 'inspector'],
  princess: ['princess', 'prince', 'royal', 'noble', 'monarch', 'heir'],
  pilot: ['pilot', 'aviator', 'astronaut', 'navigator', 'captain', 'helmsman'],
  doctor: ['doctor', 'physician', 'healer', 'medic', 'surgeon', 'apothecary'],
  engineer: ['engineer', 'mechanic', 'artificer', 'inventor', 'tinkerer'],
  hunter: ['hunter', 'tracker', 'ranger', 'archer', 'predator'],
  chef: ['chef', 'cook', 'baker', 'culinarian'],
  musician: ['musician', 'bard', 'singer', 'composer', 'minstrel'],
  artist: ['artist', 'painter', 'sculptor', 'artisan', 'creator'],
};

const PREPOSITIONS = new Set([
  'in', 'on', 'of', 'at', 'to', 'for', 'with', 'without', 'from', 'by', 'about', 'into', 'through',
  'across', 'around', 'before', 'after', 'above', 'below', 'between', 'among', 'within', 'during',
  'despite', 'toward', 'towards', 'who', 'whom', 'whose', 'that', 'which', 'where', 'when',
]);

export interface ProtagonistRoleConflict {
  relationshipName: string;
  relationshipDescription: string;
  matchedKeyword: string;
}

export interface ProtagonistRoleValidation {
  valid: boolean;
  rolePhrase?: string;
  conflicts?: ProtagonistRoleConflict[];
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/'s\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRolePhrase(seed: string | undefined): string {
  if (!seed) return '';
  let normalized = normalizeText(seed);
  // Strip leading articles.
  normalized = normalized.replace(/^(a|an|the)\s+/, '');
  // Truncate at the first prepositional phrase so setting words don't pollute the role.
  const words = normalized.split(' ');
  const cutoff = words.findIndex((w) => PREPOSITIONS.has(w));
  const roleWords = cutoff === -1 ? words : words.slice(0, cutoff);
  return roleWords.join(' ').trim();
}

function buildRoleBlocklist(rolePhrase: string): string[] {
  if (!rolePhrase) return [];
  const tokens = rolePhrase.split(/\s+/).filter((t) => t.length > 1);
  const blocklist = new Set<string>([rolePhrase, ...tokens]);

  for (const token of tokens) {
    // Singular / plural variants
    if (token.endsWith('s') && token.length > 2) {
      blocklist.add(token.slice(0, -1));
    } else {
      blocklist.add(`${token}s`);
    }

    const synonyms = ROLE_SYNONYMS[token];
    if (synonyms) {
      for (const synonym of synonyms) blocklist.add(synonym);
    }
  }

  return Array.from(blocklist);
}

/**
 * Determine whether a description match describes the protagonist's
 * relationship TO this character (no conflict) instead of this character's
 * OWN identity (conflict).
 *
 * Key insight: the relationship key IS the character's name. If the
 * description says "[term] to/of [determiner] [character_name]", the
 * description describes the protagonist's role relative to this character.
 * For example, "apprentice TO THE elder_keeper" means elder_keeper has an
 * apprentice — elder_keeper is NOT an apprentice themselves.
 *
 * If the prepositional object is ANYONE ELSE (e.g. "cartographer TO THE
 * king"), the description describes the character's OWN role, and is a
 * legitimate conflict.
 *
 * Examples (CONFLICT — character's own role):
 *   "Mara" → "cartographer TO THE king"      — Mara IS a cartographer
 *   "Twins" → "cartographers BY trade"       — Twins ARE cartographers
 *   "Lirael" → "a brilliant cartographer"    — Lirael IS a cartographer
 *
 * Examples (NO CONFLICT — protagonist's relationship):
 *   "elder_keeper" → "apprentice TO THE elder_keeper"  — keeper is a mentor
 *   "sage" → "student OF THE sage"                      — sage is a teacher
 */
const ROLE_RELATIONSHIP_PATTERN = /^(?:to|of)\s+(?:the|a|an|their|my|our)\s+/i;

function isRelationshipDescription(descNorm: string, term: string, relationshipKey: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  const match = pattern.exec(descNorm);
  if (!match) return false;

  const afterMatch = descNorm.slice(match.index + match[0].length).trim();

  // Check if the matched term is followed by "to/of + determiner".
  const relMatch = afterMatch.match(ROLE_RELATIONSHIP_PATTERN);
  if (!relMatch) return false;

  // Extract the noun phrase after the determiner and check if it matches
  // the relationship key (the character's own name). If the prepositional
  // object IS this character's name, the description is about the
  // protagonist's relationship TO them (no conflict). If it's someone else,
  // the description describes this character's own role (conflict).
  const afterDet = afterMatch.slice(relMatch[0].length).trim();
  const firstWordAfterDet = afterDet.split(/\s+/)[0] ?? '';
  const keyFirstWord = relationshipKey.split(/\s+/)[0]?.toLowerCase() ?? '';

  // Only skip when the prepositional object is this character's name
  // (e.g., "apprentice to THE elder_keeper" → elder_keeper is the key).
  const keyMatch = new RegExp(`^${keyFirstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (keyMatch.test(firstWordAfterDet)) {
    return true; // Describes protagonist's relationship TO this character
  }

  return false;
}

function findRoleConflicts(
  relationships: Record<string, string>,
  blocklist: string[]
): ProtagonistRoleConflict[] {
  const conflicts: ProtagonistRoleConflict[] = [];
  for (const [name, description] of Object.entries(relationships)) {
    const nameNorm = normalizeText(name);
    const descNorm = normalizeText(description);
    for (const term of blocklist) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'i');

      // Name match is always a conflict — the character is literally named
      // after the protagonist's role.
      if (pattern.test(nameNorm)) {
        conflicts.push({ relationshipName: name, relationshipDescription: description, matchedKeyword: term });
        break;
      }

      // Description match: check whether the matched term describes the
      // character's OWN role or the protagonist's relationship TO them.
      if (pattern.test(descNorm) && !isRelationshipDescription(descNorm, term, name)) {
        conflicts.push({ relationshipName: name, relationshipDescription: description, matchedKeyword: term });
        break;
      }
    }
  }
  return conflicts;
}

export function validateProtagonistRoleUniqueness(
  bible: CharacterBible,
  seed: string | undefined
): ProtagonistRoleValidation {
  const rolePhrase = extractRolePhrase(seed);
  if (!rolePhrase) return { valid: true };

  const blocklist = buildRoleBlocklist(rolePhrase);
  if (blocklist.length === 0) return { valid: true };

  const conflicts = findRoleConflicts(bible.relationships, blocklist);
  return conflicts.length === 0
    ? { valid: true, rolePhrase }
    : { valid: false, rolePhrase, conflicts };
}

function buildRetryPrompt(basePrompt: string, conflicts: ProtagonistRoleConflict[], rolePhrase: string): string {
  const conflictLines = conflicts
    .map((c) => `- ${c.relationshipName}: "${c.relationshipDescription}" (matches "${c.matchedKeyword}")`)
    .join('\n');
  return `${basePrompt}\n\nCORRECTION: The previous bible invented supporting characters that duplicate the protagonist's role as a "${rolePhrase}". These entries are forbidden:\n${conflictLines}\n\nSupporting characters must have COMPLEMENTARY roles (mentor, rival, friend, family member, antagonist) and must NEVER be a "${rolePhrase}" or any synonym of it.`;
}

const GENRE_TEMPLATES: Record<string, { personality: string; arc: string }> = {
  fantasy: {
    personality: 'connected to nature, wise beyond years, speaks in metaphors',
    arc: 'discovers hidden power within, learns true strength comes from compassion',
  },
  horror: {
    personality: 'perceptive beyond their years, haunted by intuition, gentle but watchful',
    arc: 'confronts deepest fears, must choose between safety and truth',
  },
  adventure: {
    personality: 'curious and brave, determined in the face of danger, loyal to companions',
    arc: 'grows from seeker to hero, learns that the real treasure was the journey',
  },
  mystery: {
    personality: 'observant and patient, pieces together what others miss, thoughtful',
    arc: 'unravels a truth that changes everything, must decide what to do with knowledge',
  },
  'sci-fi': {
    personality: 'logical yet compassionate, questions authority, adaptable to change',
    arc: 'discovers what makes them human in a world of artificial intelligence',
  },
};

function getGenreTemplate(genre: string): { personality: string; arc: string } {
  const normalized = genre.toLowerCase();
  for (const [key, template] of Object.entries(GENRE_TEMPLATES)) {
    if (normalized.includes(key)) return template;
  }
  return {
    personality: 'curious and kind, brave but not reckless, connected to the world around them',
    arc: 'grows through challenges, discovers inner strength',
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

function normalizeGender(raw: unknown): 'male' | 'female' | 'neutral' {
  if (typeof raw !== 'string') return 'neutral';
  const lower = raw.toLowerCase().trim();
  if (lower === 'male' || lower === 'm' || lower === 'man' || lower === 'boy' || lower === 'masculine') return 'male';
  if (lower === 'female' || lower === 'f' || lower === 'woman' || lower === 'girl' || lower === 'feminine') return 'female';
  if (lower === 'neutral' || lower === 'nonbinary' || lower === 'non-binary' || lower === 'nb' || lower === 'enby' || lower === 'they') return 'neutral';
  return 'neutral';
}

function parseCharacterBible(obj: Record<string, unknown>, fallback: CharacterBible): CharacterBible {
  return {
    speechPatterns:
      typeof obj.speechPatterns === 'string' ? obj.speechPatterns : fallback.speechPatterns,
    clothing: typeof obj.clothing === 'string' ? obj.clothing : fallback.clothing,
    facialFeatures:
      typeof obj.facialFeatures === 'string' ? obj.facialFeatures : fallback.facialFeatures,
    emotions: isStringArray(obj.emotions) ? obj.emotions.slice(0, 6) : fallback.emotions,
    relationships: isStringRecord(obj.relationships) ? obj.relationships : {},
    catchphrases: isStringArray(obj.catchphrases) ? obj.catchphrases.slice(0, 3) : [],
    physicalMannerisms:
      typeof obj.physicalMannerisms === 'string'
        ? obj.physicalMannerisms
        : fallback.physicalMannerisms,
    gender: normalizeGender(obj.gender),
  };
}

export async function generateCharacterBible(
  input: CharacterBibleInput
): Promise<CharacterBible> {
  const { name, genre, setting, role, seedGender, seed } = input;
  const safeName = sanitizeForPrompt(name);
  const safeGenre = sanitizeForPrompt(genre);
  const safeSetting = sanitizeForPrompt(setting);
  const safeSeed = sanitizeForPrompt(seed);
  const template = getGenreTemplate(safeGenre);
  const rolePhrase = extractRolePhrase(safeSeed);

  const systemPrompt = `You are a creative character designer for original hand-painted storybook anime stories. You create rich, detailed character profiles that ensure visual and behavioral consistency across episodes. Always respond with valid JSON only.`;

  // M31: Add a `gender` field to the JSON schema so the AI commits to
  // male/female/neutral for the character. Without this, the scene
  // narration prompt had no anchor for protagonist pronouns and the LLM
  // defaulted to female for fantasy.
  //
  // L4-CHAR-ROLE: When the caller provides a `seed` (the user-typed
  // prompt), echo it as a ROLE HINT so the AI commits to the
  // protagonist's narrative role (cartographer, thief, scholar, ...)
  // rather than inventing a parallel supporting character with the
  // same role. The hint is framed as a rule, not a suggestion, so the
  // AI cannot quietly invent a second character that conflicts with
  // the protagonist's role.
  const roleHint = safeSeed && safeSeed.trim().length > 0
    ? `\nROLE HINT (must be respected): The user-supplied seed describes ${safeName} as follows. Do NOT invent supporting characters who occupy the same role. The protagonist is the protagonist — supporting cast should have complementary roles (mentor, rival, friend, antagonist), never a duplicate role.\nSeed: "${safeSeed.replace(/\s+/g, ' ').trim().slice(0, 400)}"\n`
    : '';

  const baseUserPrompt = `Create a Character Bible for ${safeName}, the ${role} of an original hand-painted storybook anime ${safeGenre} story set in ${safeSetting}.${roleHint}

Personality basis: ${template.personality}
Character arc: ${template.arc}

Respond ONLY with valid JSON. No markdown, no commentary.

{
  "speechPatterns": "how this character speaks",
  "clothing": "detailed description of attire",
  "facialFeatures": "distinctive facial features",
  "emotions": ["five to six primary emotions"],
  "relationships": {"otherCharacterName": "relationship description"},
  "catchphrases": ["two or three short signature phrases"],
  "physicalMannerisms": "distinctive physical habits",
  "gender": "Exactly one of: male, female, neutral${seedGender ? ` — the seed suggests ${seedGender}, but evaluate the evidence independently` : ''}"
}`;

  const fallback: CharacterBible = {
    speechPatterns: template.personality,
    clothing: 'simple comfortable clothing suitable for adventure',
    facialFeatures: 'expressive eyes that reflect their emotional state',
    emotions: ['curiosity', 'determination', 'wonder', 'gentle concern', 'quiet resolve'],
    relationships: {},
    catchphrases: [],
    physicalMannerisms: 'thoughtful pauses before speaking, gentle hand gestures',
    gender: seedGender ?? 'neutral',
  };

  // L4-CHAR-ROLE: deterministic validation loop. The prompt hint reduces
  // duplicates but cannot guarantee compliance; this validator rejects any
  // bible whose supporting-character relationships overlap the protagonist's
  // role (or known synonyms) and retries with a correction prompt.
  let lastConflicts: ProtagonistRoleConflict[] = [];
  for (let attempt = 0; attempt <= ROLE_UNIQUE_RETRIES; attempt++) {
    try {
      const userPrompt =
        attempt > 0 && lastConflicts.length > 0
          ? buildRetryPrompt(baseUserPrompt, lastConflicts, rolePhrase)
          : baseUserPrompt;
      const response = await generateWithMistral(systemPrompt, userPrompt, { stage: 'blueprint' });
      const parsed: unknown = safeJsonParse(response);
      if (!parsed || typeof parsed !== 'object') throw new Error('Parsed value is not an object');
      const bible = parseCharacterBible(parsed as Record<string, unknown>, fallback);

      // L1: validate against the SANITIZED seed the model actually saw —
      // if sanitizeForPrompt altered the text, the validator and the model
      // previously reasoned about different role phrases.
      const validation = validateProtagonistRoleUniqueness(bible, safeSeed);
      if (validation.valid) {
        return bible;
      }

      lastConflicts = validation.conflicts ?? [];
      logger.warn(
        { name, attempt, rolePhrase, conflicts: lastConflicts },
        'Character bible contains duplicate protagonist role'
      );

      if (attempt === ROLE_UNIQUE_RETRIES) {
        const reason = `duplicate protagonist role after ${ROLE_UNIQUE_RETRIES} retries`;
        await logFallback('character_bible', reason, name);
        return fallback;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: errMsg, name }, 'Character bible generation failed, using defaults');
      await logFallback('character_bible', errMsg, name);
      return fallback;
    }
  }

  return fallback;
}

