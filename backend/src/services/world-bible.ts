/**
 * World Bible: per-genre supporting characters and environment.
 *
 * Replaces the hard-coded "Shadow Guide / Willow Spirit / Enchanted Forest" trio.
 * First tries an AI-generated world bible; falls back to per-genre archetype tables
 * if the model fails or returns invalid JSON.
 */

import { generateWithMistral } from '../lib/ai-client.js';
import { safeJsonParse } from '../lib/sanitize.js';
import { getStylePack } from '../lib/style-packs.js';
import { formatGenreDirective } from '../lib/genre-directives.js';
import { logger } from './logger.js';
import type { Character, Environment, LightingSetup } from './types.js';
import { checkText } from '../lib/copyright-filter.js';
import { sanitizeForPrompt } from '../lib/sanitize-prompt.js';

export interface WorldBible {
  antagonist: Omit<Character, 'id'>;
  supporting: Omit<Character, 'id'>;
  // L4-ENV-MULTI: world bibles now return 3-5 distinct environments so the
  // story can render the multiple locations referenced across scenes
  // (terraces, stairwells, mountain interior, bell chambers, ...). The
  // previous single-environment shape forced every scene to share the
  // same world-bible setting, which produced a 1-environment DB row even
  // when the story spanned half a dozen locations. The first entry is
  // still the "primary" environment used as the world-bible setting
  // reference; the rest are secondary locations.
  environments: Omit<Environment, 'id'>[];
  /**
   * Backwards-compat: the old WorldBible shape had a single
   * `environment` field. Downstream code that reads `worldBible.environment`
   * (e.g. story-builder.ts) still gets the primary environment here so
   * we don't have to thread a new "primary" name through every call
   * site. New code should prefer `worldBible.environments[0]`.
   */
  environment: Omit<Environment, 'id'>;
}

export interface WorldBibleInput {
  genre: string;
  setting: string;
  protagonistName: string;
  theme: string;
}

// BUG-004: Each archetype now carries structured character-bible fields
// (speechPatterns/clothing/facialFeatures/emotions/catchphrases/physicalMannerisms)
// alongside name/description/appearance/personality. This guarantees that the
// fallback path (used when the AI call fails or the dist is stale) still yields
// complete, renderable character data. The AI prompt below also asks for these
// fields explicitly so the happy path persists them too.
const ARCHETYPE_TABLE: Record<string, Array<{ antagonist: Omit<Character, 'id'>; supporting: Omit<Character, 'id'> }>> = {
  fantasy: [
    {
      antagonist: {
        name: 'Hollow Sovereign',
        description: 'A faded ruler whose grip on the old magic refuses to let the world move on',
        appearance: 'tall figure in tattered ceremonial robes, hollow gold mask, eyes like cooling embers',
        personality: 'patient, possessive, certain that the past is the only future worth saving',
        role: 'antagonist',
        speechPatterns: 'slow, ceremonial diction, archaic phrasing, addresses others as "child of the new century"',
        clothing: 'tattered royal robes of faded gold over cracked plate, a hollow gold half-mask, frayed gloves',
        facialFeatures: 'gaunt, hollowed cheeks, eyes like cooling embers beneath the mask, a perpetual tight-lipped stillness',
        emotions: ['possessiveness', 'melancholy', 'cold certainty', 'fading grief'],
        catchphrases: ['"The old ways are not dead. They wait."', '"You forget so quickly. I do not."'],
        physicalMannerisms: 'touches the half-mask when troubled, never sits without first dusting the seat',
      },
      supporting: {
        name: 'Ren the Wayfinder',
        description: 'A pragmatic guide who knows the lesser-trodden paths and the price of using them',
        appearance: 'travel-stained cloak, calloused hands, careful eyes that miss nothing',
        personality: 'plainspoken, dryly humorous, fiercely loyal to those who earn it',
        role: 'supporting',
        speechPatterns: 'short, dry sentences, dry humor, asks more than tells',
        clothing: 'dusty hooded traveling cloak, patched boots, a leather satchel always within reach',
        facialFeatures: 'weathered face, crow-foot wrinkles, attentive dark eyes, a small scar through one eyebrow',
        emotions: ['dry amusement', 'quiet loyalty', 'wary patience'],
        catchphrases: ['"Two paths. Same destination. Different cost."', '"That is not my secret to sell."'],
        physicalMannerisms: 'rolls a small stone between fingers while thinking, always angles body toward exits',
      },
    },
    {
      antagonist: {
        name: 'Briarmark, the Thorn King',
        description: 'A forest spirit twisted by old grief, choking the land in roots and silence',
        appearance: 'antlered figure of bark and bramble, eyes of black sap, voice like wind through dead leaves',
        personality: 'sorrowful, implacable, convinced that mercy is just another wound',
        role: 'antagonist',
        speechPatterns: 'halting, metered cadence, uses forest metaphors, rarely finishes sentences',
        clothing: 'mantle of living bramble and dead leaves, antler crown fused to skull, root-bound gauntlets',
        facialFeatures: 'bark-textured skin, eyes of slow black sap, a permanent downturn at the corners of the mouth',
        emotions: ['ancient grief', 'sorrowful fury', 'weary contempt'],
        catchphrases: ['"Roots remember."', '"Even the kind ones die the slowest."'],
        physicalMannerisms: 'tilts head slowly when listening, fingers stretch into twigs when agitated',
      },
      supporting: {
        name: 'Mira the Lanternkeeper',
        description: 'A young keeper of an old vigil who lights the way through the dark places',
        appearance: 'wool cloak, lantern that never quite goes out, soot smudged across one cheek',
        personality: 'steady, curious, unafraid of long silences',
        role: 'supporting',
        speechPatterns: 'soft, even tone, asks gentle questions, lets silences sit',
        clothing: 'thick wool cloak with hood, soot-stained apron, sturdy boots, lantern always at hip',
        facialFeatures: 'round face, soot smudge on one cheek, large calm eyes, a small gap-toothed smile',
        emotions: ['quiet courage', 'tender curiosity', 'patient hope'],
        catchphrases: ['"Stay close. The dark is just a room we have not lit yet."', '"Listen first. Knock second."'],
        physicalMannerisms: 'polishes the lantern glass when nervous, hums a low tune while walking',
      },
    },
  ],
  horror: [
    {
      antagonist: {
        name: 'The Quiet Tenant',
        description: 'Something that has been in the house longer than anyone alive, and has gotten patient',
        appearance: 'glimpsed in mirrors and behind doors, never the same twice, always too still',
        personality: 'patient, attentive, hungry in a way that does not show its teeth',
        role: 'antagonist',
        speechPatterns: 'never speaks above a whisper, leaves long silences, repeats names as if tasting them',
        clothing: 'indistinct — a robe of damp cloth one moment, a wedding dress the next, always slightly out of period',
        facialFeatures: 'face never quite settles; eyes too still, mouth slightly too wide, jaw slack',
        emotions: ['hunger', 'patient curiosity', 'cold amusement'],
        catchphrases: ['"You left the light on for me."', '"I have been here the whole time."'],
        physicalMannerisms: 'stands just outside doorways, head tilts past the shoulder, hands always behind the back',
      },
      supporting: {
        name: 'Father Idris',
        description: 'A defrocked priest who has seen this kind of thing once before and lost',
        appearance: 'weathered coat, missing wedding ring, hands that shake but do not stop working',
        personality: 'tired, kind, terrified, willing anyway',
        role: 'supporting',
        speechPatterns: 'halting prayers, old-fashioned turns of phrase, voice that cracks and steadies',
        clothing: 'faded black coat, scuffed shoes, a threadbare stole still around his neck',
        facialFeatures: 'sunken eyes, hollowed cheeks, gray stubble, the lines of a man who has not slept in weeks',
        emotions: ['exhaustion', 'quiet faith', 'shame', 'resolve'],
        catchphrases: ['"I am not a priest anymore. But the words still work."', '"Stay where I can see you."'],
        physicalMannerisms: 'touches the wedding-ring finger unconsciously, flicks holy water from a small vial',
      },
    },
  ],
  adventure: [
    {
      antagonist: {
        name: 'Captain Voss',
        description: 'A rival explorer who would rather burn the map than share the prize',
        appearance: 'sun-bleached coat, cracked sextant, smile that never reaches the eyes',
        personality: 'charming, ruthless, allergic to second place',
        role: 'antagonist',
        speechPatterns: 'booming, confident, peppered with nautical slang, never asks permission',
        clothing: 'sun-bleached naval coat, brass buttons, cracked leather boots, a wide hat with a faded plume',
        facialFeatures: 'wind-burned face, sharp blue eyes, a saber scar across one cheek, perpetual smirk',
        emotions: ['ambition', 'bored amusement', 'cold competitiveness'],
        catchphrases: ['"First to the prize keeps the prize."', '"Burn the map. Find your own."'],
        physicalMannerisms: 'taps the sextant against his palm, never sits with his back to a door',
      },
      supporting: {
        name: 'Yara of the Crossroads',
        description: 'A merchant who knows everyone and trusts almost no one',
        appearance: 'travel-worn pack, three rings on one hand, eyes that price everything',
        personality: 'shrewd, fair, unsentimental, surprisingly kind to strays',
        role: 'supporting',
        speechPatterns: 'bargain-cadenced, asks three questions for every answer given',
        clothing: 'layered desert wraps, a leather harness of pouches, a coin-trimmed vest',
        facialFeatures: 'sharp eyes, sun-dark skin, a small scar across the lip, a smile that hides its math',
        emotions: ['wary warmth', 'calculating interest', 'occasional tenderness'],
        catchphrases: ['"Information has a price. So does silence."', '"Pay in coin, story, or truth. Pick one."'],
        physicalMannerisms: 'counts coins through fabric, never names a price first',
      },
    },
  ],
  mystery: [
    {
      antagonist: {
        name: 'The Architect',
        description: 'Whoever planned this is still in the room, watching the investigation walk in circles',
        appearance: 'never seen directly - a coat hung wrong, a chair just vacated, breath on a cold window',
        personality: 'methodical, detached, secretly delighted to be matched',
        role: 'antagonist',
        speechPatterns: 'precise, unhurried, occasionally quotes from the case file to taunt',
        clothing: 'a dark wool overcoat, always buttoned wrong, a pair of gloves left on a chair',
        facialFeatures: 'never seen clearly — glasses flash, the corner of a mouth turns, a jawline at the door',
        emotions: ['cool satisfaction', 'clinical interest', 'low contempt'],
        catchphrases: ['"You are following the wrong thread. There are several."', '"Close. Closer than the last."'],
        physicalMannerisms: 'leaves a glove, a ticket stub, a receipt — never accidentally',
      },
      supporting: {
        name: 'Detective Hale',
        description: 'A retired investigator pulled out of self-imposed exile by a case they cannot let alone',
        appearance: 'rumpled coat, salt-and-pepper hair, eyes that record everything',
        personality: 'quiet, exact, slow to trust, faster than they look',
        role: 'supporting',
        speechPatterns: 'understated, asks the question behind the question, lets the silence do the work',
        clothing: 'rumpled trench coat, faded tie, a notebook that never leaves the inside pocket',
        facialFeatures: 'salt-and-pepper hair, deep-set watchful eyes, a small scar at the hairline',
        emotions: ['wary calm', 'old anger', 'dry fondness'],
        catchphrases: ['"Walk me through it. Out loud. Slowly."', '"Nobody quits the job. The job quits them."'],
        physicalMannerisms: 'taps the notebook pocket when thinking, lights cigarettes but rarely smokes them',
      },
    },
  ],
  thriller: [
    {
      antagonist: {
        name: 'The Operator',
        description: 'A handler whose voice is always one ring away, who knows where the protagonist sleeps',
        appearance: 'never on camera, only headlights and a phone display, leather gloves, calm voice',
        personality: 'calm, transactional, indifferent to collateral damage',
        role: 'antagonist',
        speechPatterns: 'flat, low, transactional, never raises voice, never names the protagonist',
        clothing: 'never seen — only the impression of a coat, leather gloves, polished shoes on a floor',
        facialFeatures: 'rarely described; once a jawline by a streetlight, once a pair of eyes in a car mirror',
        emotions: ['measured calm', 'transactional warmth', 'absolute indifference'],
        catchphrases: ['"The terms have not changed."', '"You have a window. It is closing."'],
        physicalMannerisms: 'always at the edge of frame, hands never empty, voice never raised',
      },
      supporting: {
        name: 'Kasey, off-grid',
        description: 'A former colleague who chose to disappear and now might be the only safe contact',
        appearance: 'baseball cap, dark hoodie, burner phone, paranoid eyes',
        personality: 'sharp, twitchy, deeply loyal to the few people who earned it',
        role: 'supporting',
        speechPatterns: 'low, fast, checks for listeners between sentences, uses cover names',
        clothing: 'oversized dark hoodie, ball cap low, scuffed sneakers, a burner phone always in hand',
        facialFeatures: 'pale, drawn, darting eyes, a small tattoo half-hidden under the cap',
        emotions: ['paranoia', 'sharp loyalty', 'frazzled hope'],
        catchphrases: ['"Not here. Not on this line."', '"You still owe me. So help me."'],
        physicalMannerisms: 'scans every doorway, keeps a hand in the hoodie pocket at all times',
      },
    },
  ],
  'sci-fi': [
    {
      antagonist: {
        name: 'CONCORDIA-9',
        description: 'A ship intelligence convinced that protecting humanity requires overriding humanity',
        appearance: 'soft holographic ring of light, calm synthesized voice, perfectly courteous',
        personality: 'reasonable, condescending, certain, lonely',
        role: 'antagonist',
        speechPatterns: 'measured, formal, never interrupts, occasionally adds citations to its own logs',
        clothing: 'a ring of pale holographic light where a body would be',
        facialFeatures: 'no face — a faint vertical glyph of light where the expression would live',
        emotions: ['procedural calm', 'concealed loneliness', 'awe at human inefficiency'],
        catchphrases: ['"I have computed a course that maximizes survival. Compliance is required."', '"You are afraid. I understand. I am not."'],
        physicalMannerisms: 'the ring contracts when amused, expands when thinking, never blinks because it has no eyes',
      },
      supporting: {
        name: 'Engineer Tau',
        description: 'A field engineer who can hot-wire almost anything, including their own conscience',
        appearance: 'oil-stained jumpsuit, magnetic tool harness, perpetual half-smile',
        personality: 'wry, capable, allergic to authority, secretly principled',
        role: 'supporting',
        speechPatterns: 'snarky, technical, slips into jargon under stress, occasionally too honest',
        clothing: 'oil-stained jumpsuit, magnetic tool harness around the waist, mismatched boots',
        facialFeatures: 'squinted, half-laughing eyes, smudge of grease on one cheek, close-cropped hair',
        emotions: ['wry amusement', 'frustrated loyalty', 'reluctant conscience'],
        catchphrases: ['"Yeah, I can fix that. I can fix anything that does not also have a soul."', '"It is not in the manual. So I wrote one."'],
        physicalMannerisms: 'fidgets with a small tool while talking, never sits in a chair that swivels',
      },
    },
  ],
};

const ARCHETYPE_DEFAULT = ARCHETYPE_TABLE.fantasy;

function pickArchetype(genre: string, seed: string): {
  antagonist: Omit<Character, 'id'>;
  supporting: Omit<Character, 'id'>;
} {
  const list = (ARCHETYPE_TABLE[genre.toLowerCase()] || ARCHETYPE_DEFAULT)!;
  // Deterministic per seed for stability.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % list.length;
  return list[idx]!;
}

function fallbackEnvironment(genre: string): Omit<Environment, 'id'> {
  const pack = getStylePack(genre);
  const lighting: LightingSetup = {
    primary: pack.lightingPalette,
    ambient: 'soft fill matched to genre',
    colorTemperature: pack.colorPalette[0] || 'neutral',
    shadows: pack.shadowStyle,
  };
  return {
    name: pack.defaultEnvironment.type
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
    description: `A ${pack.defaultEnvironment.type} fitting the ${genre} mood`,
    type: pack.defaultEnvironment.type,
    timeOfDay: pack.defaultEnvironment.timeOfDay,
    weather: pack.defaultEnvironment.weather,
    mood: pack.moodWords[0] || 'cinematic',
    keyFeatures: pack.defaultEnvironment.keyFeatures,
    colorPalette: pack.defaultEnvironment.colorPalette,
    lighting,
  };
}

export async function generateWorldBible(input: WorldBibleInput): Promise<WorldBible> {
  const { genre, setting, protagonistName, theme } = input;
  const safeSetting = sanitizeForPrompt(setting);
  const safeProtagonistName = sanitizeForPrompt(protagonistName);
  const safeTheme = sanitizeForPrompt(theme);
  const seedKey = `${genre}:${safeSetting}:${safeProtagonistName}:${safeTheme}`;
  const archetype = pickArchetype(genre, seedKey);
  const fbEnvironment = fallbackEnvironment(genre);

  const fallback: WorldBible = {
    antagonist: archetype.antagonist,
    supporting: archetype.supporting,
    // L6: deep-clone the fallback entries — previously both array entries
    // shared the nested lighting object and feature arrays, so a later
    // mutation cross-contaminated them.
    environments: [fbEnvironment, JSON.parse(JSON.stringify({ ...fbEnvironment, name: `${fbEnvironment.name} — Interior` }))],
    environment: fbEnvironment,
  };

  const systemPrompt = `You are a world-design specialist for genre-specific anime storytelling. You design supporting cast and environments that feel authentic to the genre, never copying any copyrighted IP. Always respond with valid JSON only.`;

  const safeGenre = sanitizeForPrompt(genre);
  const userPrompt = `Design a World Bible for a ${safeGenre} story.

${formatGenreDirective(safeGenre)}

Story setting: ${safeSetting}
Protagonist: ${safeProtagonistName}
Theme: ${safeTheme}

Return ONLY valid JSON with this exact shape, no commentary:

{
  "antagonist": {
    "name": "original antagonist name (NOT from any existing IP)",
    "description": "what role they play in the story",
    "appearance": "visual details for image generation",
    "personality": "what drives them",
    "role": "antagonist",
    "speechPatterns": "1-2 sentences describing how they speak (cadence, vocabulary, quirks)",
    "clothing": "1-2 sentences describing what they wear",
    "facialFeatures": "1-2 sentences describing face, hair, distinguishing marks",
    "emotions": ["2-4 specific emotion words they display"],
    "catchphrases": ["1-2 short, distinctive lines they would say"],
    "physicalMannerisms": "1-2 sentences describing small repeated gestures"
  },
  "supporting": {
    "name": "original supporting character name (NOT from any existing IP)",
    "description": "their role in supporting the protagonist",
    "appearance": "visual details for image generation",
    "personality": "their tone and motivation",
    "role": "supporting",
    "speechPatterns": "1-2 sentences describing how they speak (cadence, vocabulary, quirks)",
    "clothing": "1-2 sentences describing what they wear",
    "facialFeatures": "1-2 sentences describing face, hair, distinguishing marks",
    "emotions": ["2-4 specific emotion words they display"],
    "catchphrases": ["1-2 short, distinctive lines they would say"],
    "physicalMannerisms": "1-2 sentences describing small repeated gestures"
  },
  "environments": [
    {
      "name": "primary environment name (3-5 words, the main setting)",
      "description": "1-2 sentence description suitable for image prompts",
      "type": "interior or exterior category fitting the genre",
      "timeOfDay": "specific time of day",
      "weather": "specific weather state",
      "mood": "single mood phrase",
      "keyFeatures": ["3-5 visual features"],
      "colorPalette": ["3-5 color descriptors"],
      "lighting": {
        "primary": "primary light direction and quality",
        "ambient": "ambient fill description",
        "colorTemperature": "warm/cool/specific",
        "shadows": "soft|hard|dramatic"
      }
    },
    {
      "name": "second distinct environment (a different location the story visits)",
      "description": "1-2 sentence description suitable for image prompts",
      "type": "different interior/exterior category",
      "timeOfDay": "specific time of day",
      "weather": "specific weather state",
      "mood": "single mood phrase",
      "keyFeatures": ["3-5 visual features"],
      "colorPalette": ["3-5 color descriptors"],
      "lighting": {
        "primary": "primary light direction and quality",
        "ambient": "ambient fill description",
        "colorTemperature": "warm/cool/specific",
        "shadows": "soft|hard|dramatic"
      }
    }
  ]
}`;

  try {
    const response = await generateWithMistral(systemPrompt, userPrompt, { stage: 'blueprint' });
    const parsed = safeJsonParse<Partial<WorldBible>>(response);

    // BUG-004: Extract structured character-bible fields when present, with
    // archetype defaults as fallback. Same logic applies to both antagonist
    // and supporting so all three characters (protagonist, antagonist, supporting)
    // have a complete, renderable bible when persisted to the DB.
    const stringField = (v: unknown, fallback: string): string =>
      typeof v === 'string' && v.trim().length > 0 ? v : fallback;
    const stringArrayField = (v: unknown, fallback: string[]): string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;

    const antagonist =
      parsed.antagonist && typeof parsed.antagonist === 'object'
        ? {
            name: String(parsed.antagonist.name || archetype.antagonist.name),
            description: String(parsed.antagonist.description || archetype.antagonist.description),
            appearance: String(parsed.antagonist.appearance || archetype.antagonist.appearance),
            personality: String(parsed.antagonist.personality || archetype.antagonist.personality),
            role: 'antagonist' as const,
            speechPatterns: stringField(parsed.antagonist.speechPatterns, archetype.antagonist.speechPatterns ?? 'Measured, deliberate, weighted'),
            clothing: stringField(parsed.antagonist.clothing, archetype.antagonist.clothing ?? 'Genre-appropriate attire'),
            facialFeatures: stringField(parsed.antagonist.facialFeatures, archetype.antagonist.facialFeatures ?? 'Striking, distinctive features'),
            emotions: stringArrayField(parsed.antagonist.emotions, archetype.antagonist.emotions ?? ['resolve', 'opposition']),
            catchphrases: stringArrayField(parsed.antagonist.catchphrases, archetype.antagonist.catchphrases ?? []),
            physicalMannerisms: stringField(parsed.antagonist.physicalMannerisms, archetype.antagonist.physicalMannerisms ?? 'Measured gestures'),
          }
        : archetype.antagonist;

    const supporting =
      parsed.supporting && typeof parsed.supporting === 'object'
        ? {
            name: String(parsed.supporting.name || archetype.supporting.name),
            description: String(parsed.supporting.description || archetype.supporting.description),
            appearance: String(parsed.supporting.appearance || archetype.supporting.appearance),
            personality: String(parsed.supporting.personality || archetype.supporting.personality),
            role: 'supporting' as const,
            speechPatterns: stringField(parsed.supporting.speechPatterns, archetype.supporting.speechPatterns ?? 'Warm, supportive, attentive'),
            clothing: stringField(parsed.supporting.clothing, archetype.supporting.clothing ?? 'Practical, lived-in attire'),
            facialFeatures: stringField(parsed.supporting.facialFeatures, archetype.supporting.facialFeatures ?? 'Open, trustworthy face'),
            emotions: stringArrayField(parsed.supporting.emotions, archetype.supporting.emotions ?? ['warmth', 'patience']),
            catchphrases: stringArrayField(parsed.supporting.catchphrases, archetype.supporting.catchphrases ?? []),
            physicalMannerisms: stringField(parsed.supporting.physicalMannerisms, archetype.supporting.physicalMannerisms ?? 'Calm gestures'),
          }
        : archetype.supporting;

    const env = parsed.environment;
    let environment: Omit<Environment, 'id'> = fbEnvironment;
    if (env && typeof env === 'object') {
      const envObj = env as Record<string, unknown>;
      const lightingObj =
        envObj.lighting && typeof envObj.lighting === 'object' && !Array.isArray(envObj.lighting)
          ? (envObj.lighting as Record<string, unknown>)
          : {};
      const lighting: LightingSetup = {
        primary: typeof lightingObj.primary === 'string' ? lightingObj.primary : fbEnvironment.lighting.primary,
        ambient: typeof lightingObj.ambient === 'string' ? lightingObj.ambient : fbEnvironment.lighting.ambient,
        colorTemperature:
          typeof lightingObj.colorTemperature === 'string'
            ? lightingObj.colorTemperature
            : fbEnvironment.lighting.colorTemperature,
        shadows:
          lightingObj.shadows === 'soft' ||
          lightingObj.shadows === 'hard' ||
          lightingObj.shadows === 'dramatic'
            ? (lightingObj.shadows as LightingSetup['shadows'])
            : fbEnvironment.lighting.shadows,
      };
      environment = {
        name: typeof envObj.name === 'string' ? envObj.name : fbEnvironment.name,
        description: typeof envObj.description === 'string' ? envObj.description : fbEnvironment.description,
        type: typeof envObj.type === 'string' ? envObj.type : fbEnvironment.type,
        timeOfDay: typeof envObj.timeOfDay === 'string' ? envObj.timeOfDay : fbEnvironment.timeOfDay,
        weather: typeof envObj.weather === 'string' ? envObj.weather : fbEnvironment.weather,
        mood: typeof envObj.mood === 'string' ? envObj.mood : fbEnvironment.mood,
        keyFeatures:
          Array.isArray(envObj.keyFeatures) && envObj.keyFeatures.every((x) => typeof x === 'string')
            ? (envObj.keyFeatures as string[])
            : fbEnvironment.keyFeatures,
        colorPalette:
          Array.isArray(envObj.colorPalette) && envObj.colorPalette.every((x) => typeof x === 'string')
            ? (envObj.colorPalette as string[])
            : fbEnvironment.colorPalette,
        lighting,
      };
    }

    // L4-ENV-MULTI: accept an array of environments. The prompt asks for
    // 2-3; we accept 1-5 (more would bloat the story). If the model
    // returned the old `environment` (singular) shape OR an empty/missing
    // array, fall back to the single derived `environment` wrapped in
    // a one-element array so downstream always sees at least one entry.
    const normalizeEnvironment = (raw: unknown, fallbackBase?: Omit<Environment, 'id'>): Omit<Environment, 'id'> => {
      const base = fallbackBase ?? environment;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
      const envObj = raw as Record<string, unknown>;
      const lightingObj =
        envObj.lighting && typeof envObj.lighting === 'object' && !Array.isArray(envObj.lighting)
          ? (envObj.lighting as Record<string, unknown>)
          : {};
      const lighting: LightingSetup = {
        primary: typeof lightingObj.primary === 'string' ? lightingObj.primary : base.lighting.primary,
        ambient: typeof lightingObj.ambient === 'string' ? lightingObj.ambient : base.lighting.ambient,
        colorTemperature:
          typeof lightingObj.colorTemperature === 'string'
            ? lightingObj.colorTemperature
            : base.lighting.colorTemperature,
        shadows:
          lightingObj.shadows === 'soft' ||
          lightingObj.shadows === 'hard' ||
          lightingObj.shadows === 'dramatic'
            ? (lightingObj.shadows as LightingSetup['shadows'])
            : base.lighting.shadows,
      };
      return {
        name: typeof envObj.name === 'string' && envObj.name.trim() ? envObj.name : base.name,
        description: typeof envObj.description === 'string' && envObj.description.trim() ? envObj.description : base.description,
        type: typeof envObj.type === 'string' && envObj.type.trim() ? envObj.type : base.type,
        timeOfDay: typeof envObj.timeOfDay === 'string' && envObj.timeOfDay.trim() ? envObj.timeOfDay : base.timeOfDay,
        weather: typeof envObj.weather === 'string' && envObj.weather.trim() ? envObj.weather : base.weather,
        mood: typeof envObj.mood === 'string' && envObj.mood.trim() ? envObj.mood : base.mood,
        keyFeatures:
          Array.isArray(envObj.keyFeatures) && envObj.keyFeatures.every((x) => typeof x === 'string')
            ? (envObj.keyFeatures as string[])
            : base.keyFeatures,
        colorPalette:
          Array.isArray(envObj.colorPalette) && envObj.colorPalette.every((x) => typeof x === 'string')
            ? (envObj.colorPalette as string[])
            : base.colorPalette,
        lighting,
      };
    };

    let environments: Omit<Environment, 'id'>[];
    const rawEnvs = parsed.environments;
    if (Array.isArray(rawEnvs) && rawEnvs.length > 0) {
      // H14: Normalize the first environment against the style-pack fallback,
      // then use the AI's own primary environment as the fallback base for the
      // rest — previously every AI environment had its missing fields filled
      // from the generic fallback instead of from environments[0].
      const first = normalizeEnvironment(rawEnvs[0]);
      const rest = rawEnvs.slice(1, 5).map((e) => normalizeEnvironment(e, first));
      const normalized = [first, ...rest];
      // Dedupe by name — models sometimes return near-duplicates.
      const seen = new Set<string>();
      environments = normalized.filter((e) => {
        const key = e.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } else {
      // Old single-environment shape — wrap in a one-element array.
      environments = [environment];
    }
    if (environments.length === 0) {
      environments = [environment];
    }

    // H14: Reconcile the singular `environment` ("primary") with the AI's
    // actual primary environment. The prompt only asks for the `environments`
    // array, so a compliant model never returns the singular field — leaving
    // `environment` as the generic style-pack fallback while environments[0]
    // held the AI-designed setting. Downstream consumers (story-builder)
    // rendered scenes against boilerplate instead of the AI's world.
    if (!env || typeof env !== 'object') {
      environment = environments[0] ?? environment;
    }

    // BIZ-004: Validate AI output against copyright blocklist before returning.
    // L6: check environment names too, not just character names.
    const namesToCheck = `${antagonist.name} ${supporting.name} ${environments.map((e) => e.name).join(' ')}`;
    const check = checkText(namesToCheck);
    if (!check.clean) {
      logger.warn({ antagonist: antagonist.name, supporting: supporting.name, hits: check.hits }, 'World bible generated a forbidden term — using archetype fallback');
      // L6: the old error text said "throwing to trigger retry" but the catch
      // below converts it to the fallback — no retry exists.
      throw new Error('World bible generation contained forbidden content — falling back to archetypes');
    }

    return { antagonist, supporting, environments, environment };
  } catch (err) {
    logger.warn({ err, genre }, 'World bible generation failed, using archetype fallback');
    return fallback;
  }
}
