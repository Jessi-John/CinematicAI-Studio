/**
 * ai-client.canned.ts — Deterministic canned responses for the AI chat
 * completion API. Used when STORY_TEST_MODE=canned to bypass the real provider.
 *
 * Bypass rationale: the AI provider API has been intermittently unreliable in
 * test environments, causing the worker's circuit breaker to open and
 * pipelines to stall. This module provides schema-valid, deterministic
 * responses so the orchestration logic can be tested end-to-end.
 *
 * Enabled only when STORY_TEST_MODE === 'canned'. Production code paths are
 * untouched.
 *
 * Response shape detection: each pipeline stage has a distinctive system
 * prompt. We pattern-match to emit the right response shape (blueprint JSON,
 * scene prose, episode meta JSON, SEO JSON, similarity scores JSON).
 *
 * Determinism: responses are seeded from a hash of the input prompts so the
 * same input always produces the same output (useful for snapshot tests).
 */
import crypto from 'node:crypto';
import { logger } from '../services/logger.js';
import { cannedModeEnabled } from '../config/env.js';

// MUST match YOUTUBE_TITLE_MAX_LENGTH in ai-client.ts (line 26).
// If one changes, the other must change. Cannot share via import due to
// circular dependency (canned is imported by ai-client).
const YOUTUBE_TITLE_MAX_LENGTH = 100;

const SCENE_BASE = 'A gentle keeper of the Whispering Grove discovers a hidden seed that glows with quiet magic, breathing new life into the withering village around them as seasons turn and hope returns.';

function seedFromPrompts(systemPrompt: string, userPrompt: string): number {
  const h = crypto.createHash('sha256').update(systemPrompt + '|' + userPrompt).digest();
  return h.readUInt32BE(0);
}

function pickVariation(seed: number, options: string[]): string {
  return options[seed % options.length]!;
}

/**
 * Detect the response shape needed from the system/user prompt keywords.
 * Returns one of: 'blueprint' | 'scene' | 'episode-meta' | 'seo' | 'similarity' | 'default'
 */
function detectShape(systemPrompt: string, userPrompt: string): string {
  const sp = systemPrompt.toLowerCase();
  const up = userPrompt.toLowerCase();
  if (up.includes('similarityscores') || up.includes('"similarityscores"') || up.includes('score these')) return 'similarity';
  // REL-012: Check shape-specific markers in the user prompt FIRST — the system
  // prompt often contains "youtube" / "voiceover" / "world" generically, which
  // would cause misdetection. The user prompt is the more reliable signal.
  // Episode meta: requires BOTH title AND hook (specific combo).
  const hasTitle = up.includes('"title":') || /(^|\s)title(\s|,|:)/.test(up);
  const hasHook = up.includes('"hook":') || /(^|\s)hook(\s|,|:)/.test(up);
  const hasSynopsis = up.includes('"synopsis":') || /(^|\s)synopsis(\s|,|:)/.test(up);
  if (hasTitle && hasHook && hasSynopsis) return 'episode-meta';
  // Blueprint: logline is the unique marker (episode-meta has no logline).
  if (up.includes('"logline":') || /\blogline\b/.test(up)) return 'blueprint';
  // Scene: single-scene or batched scene generation.
  // Single-scene userPrompt includes "Scene N of 5"; batched prompt includes
  // "Generate 5 connected scenes". Both must map to the scene shape so canned
  // mode returns real narration rather than the default constant text (which
  // previously caused the cross-episode duplicate narration invariant to fail).
  if (/scene\s*\d+\s*of\s*5/i.test(up) || /generate\s+\d+\s+connected\s+scenes/i.test(up) || (up.includes('22') && up.includes('28')) || up.includes('narrator speaks')) return 'scene';
  // Rebalance: "Rewrite Scene X of" + "EXPAND"/"TIGHTEN" pattern from rebalanceEpisodeDuration.
  if (/\bRewrite\s+Scene\b/i.test(up) && (up.includes('expand') || up.includes('tighten'))) return 'rebalance';
  // Title-uniqueness regeneration (episode title collision retries)
  if (sp.includes('title-uniqueness') || up.includes('new unique title')) return 'title-unique';
  // Character bible / world bible
  if (sp.includes('character bible') || up.includes('character bible')) return 'character-bible';
  if ((sp.includes('world') && sp.includes('environment')) || up.includes('antagonist')) return 'world-bible';
  // YouTube SEO — only when not matching a more specific shape above.
  if (sp.includes('youtube growth') || up.includes('youtube seo') || up.includes('optimize for maximum reach')) return 'seo';
  // Humanize / voiceover
  if (sp.includes('humaniz') || up.includes('more human')) return 'humanize';
  return 'default';
}

function blueprintResponse(seed: number): string {
  const titles = [
    'The Whispering Grove',
    'Keeper of the Hidden Light',
    'The Last Blooming Seed',
    'Where the Quiet Magic Sleeps',
  ];
  const protagonists = [
    'Aeliana', 'Aiden', 'Alaric', 'Aldric', 'Aria', 'Asha', 'Asher', 'Astrid', 'Aurora', 'Avery',
    'Baelen', 'Bayle', 'Branwen', 'Brevin', 'Brynn', 'Caelum', 'Calyx', 'Cassian', 'Corin', 'Darian',
    'Darya', 'Dorian', 'Draven', 'Elara', 'Elowen', 'Elspeth', 'Emrys', 'Eira', 'Faelan', 'Fiora',
    'Gareth', 'Gavriel', 'Gwen', 'Gwyn', 'Hadrian', 'Halia', 'Hazel', 'Hestia', 'Iris', 'Isolde',
    'Ilya', 'Jora', 'Jules', 'Kael', 'Kaelen', 'Kestrel', 'Kira', 'Larken', 'Leif', 'Lucan',
    'Luna', 'Lyra', 'Maeve', 'Milo', 'Myrin', 'Nero', 'Nix', 'Nyx', 'Oona', 'Opal',
    'Oren', 'Orin', 'Pax', 'Peregrine', 'Perrin', 'Quilla', 'Quinn', 'Riven', 'Rook', 'Rowan',
    'Sage', 'Sera', 'Sylas', 'Sylvie', 'Tamsin', 'Talia', 'Tarian', 'Thorn', 'Umber', 'Una',
    'Uriel', 'Vael', 'Vanya', 'Vesper', 'Vex', 'Willa', 'Willow', 'Wynne', 'Wren', 'Xander',
    'Xanthe', 'Xyla', 'Yara', 'Yarrow', 'Zane', 'Zephyr', 'Zinnia', 'Zorion',
  ];
  const settings = [
    'a hidden grove where flowers hum with quiet magic',
    'a forgotten village at the edge of an ancient forest',
    'a windswept cliffside monastery',
    'a crystal cave beneath a sleeping mountain',
  ];
  return JSON.stringify({
    title: pickVariation(seed, titles),
    protagonistName: pickVariation(seed, protagonists),
    protagonistAge: 'sixteen',
    setting: pickVariation(seed, settings),
    theme: 'the cost of keeping a secret versus the cost of sharing it',
    logline: 'A young keeper must decide whether to protect or share a magic that could change her world.',
  });
}

function sceneResponse(_seed: number, episodeHint: number, sceneNumber: number): string {
  // 50 unique scene narrations (~22-32 words each). Each (episode, scene) pair
  // gets a distinct string so the cross-episode duplicate narration invariant
  // does not reject canned-mode stories. Crucially, the scenes use deliberately
  // DIVERSE vocabulary (lighthouse, mosaic, clockwork, glacier, ...) so the
  // pairwise Jaccard word-set similarity stays well under the 0.6 full-scene /
  // 0.7 opening-phrase thresholds used by isSceneTooSimilar — otherwise the
  // cross-episode dedup pass would false-positive on near-identical themed prose
  // and mass-replace scenes with pickGenreFallback (whose small per-genre pool
  // then collides across episodes). Sized so a 5-scene episode lands inside the
  // 121-145 word band. No episode/scene metadata, so nothing leaks into the
  // persisted narration or TTS.
  const scenes = [
    'A lighthouse keeper climbs the narrow spiral stair as fog swallows the harbor below, and the lamp sputters before catching, throwing pale amber across the black water.',
    'Beneath the cathedral floor an archaeologist brushes dust from a mosaic no map remembers, its cracked tiles depicting a drowned city of leaning towers and silent bells.',
    'The old clockmaker winds a brass sparrow and sets it on the windowsill; at midnight it opens its metal eyes and softly speaks her mother\'s long-forgotten name.',
    'Out on the salt flats a tired cartographer measures the same horizon for the third time, growing certain the distant coastline has quietly moved since only yesterday.',
    'A young violinist tunes by candlelight in the empty station, and each trembling string answers with the low whistle of a train that never quite arrives.',
    'The beekeeper lifts a frame heavy with winter honey, and hidden in the golden comb she finds a single black feather woven through it like a warning.',
    'High on the glacier a climber chips free a coin frozen mid-fall, its worn face stamped with a year that, impossibly, has not happened yet.',
    'In the flooded library a diver slowly turns pages that refuse to dissolve, reading a waterlogged letter addressed to someone who will be born tomorrow.',
    'The ferryman counts coins by lantern glow, and one silent passenger pays the crossing with a seed that blooms the instant it touches the dark water.',
    'A glassblower coaxes a spiral of blue from the roaring furnace, and the shape it finally takes is the exact sleeping curve of her youngest son.',
    'On the windswept rooftop a radio operator catches a faint broadcast from a station that was demolished thirty years before she was even born.',
    'The gardener plants a neat row of silver bulbs, and by cold morning they have rearranged themselves into the unmistakable shape of a pointing arrow.',
    'A cartographer\'s apprentice inks a coastline that keeps shifting beneath her pen, as though the whole island were slowly breathing in and out.',
    'The taxidermist stitches shut the raven\'s beak, then freezes completely as a small polite knock sounds from inside the glass display case.',
    'Deep in the copper mine a foreman strikes a vein that hums, and every single lamp along the tunnel flickers in perfect and terrible rhythm.',
    'A seamstress finds a second shadow sewn into the hem of the wedding dress, one that waves slowly whenever no one in the room is looking.',
    'The lighthouse painter works his way down the iron railing, and notices with dread that the sea below him has turned the color of milk.',
    'An organist presses a key that should be silent, and the whole cold cathedral exhales a single low chord far older than the building above the empty pews.',
    'The night watchman circles the empty museum and stops before a tall portrait whose painted subject has somehow turned her back to him.',
    'A pearl diver surfaces clutching a dark stone so cold it burns, its worn face etched with a spiral that exactly matches her own fingerprint from childhood.',
    'The chimney sweep emerges covered in soot and carrying a small music box that will only ever play when it is raining hard outside at night.',
    'A shepherd whistles for the wandering flock and hears the whistle returned from three directions at once, none of them his own lost sheep.',
    'The potter centers the wet clay and watches it slowly spin itself into a perfect raised map of a valley she has never once visited in her life.',
    'A lighthouse cat brings home a fish with silver scales arranged like letters, spelling out a single word in a language that no one alive still knows.',
    'The undertaker carefully measures a coffin for a man who walks in the very next morning, calmly and politely asking for his money back again.',
    'A storm chaser parks beneath the dark funnel and finds the wind has arranged a hundred stolen hubcaps into a perfect and deliberate silver spiral.',
    'The bookbinder presses a leather cover and feels something move beneath it, a slow and patient and unmistakable heartbeat under her open palm.',
    'A cartographer trades her brass compass for a shell, and the small needle inside now points not north but always, faithfully, toward her childhood home.',
    'The lamplighter reaches the final street and discovers every flame he lit that night has been quietly rearranged into a single question mark.',
    'A surgeon lays out her bright instruments and finds resting among them a single wooden toy soldier she lost and quietly mourned as a small child.',
    'The lighthouse radio crackles to life with a slow countdown spoken in a voice the keeper recognizes as his own, only very much younger than now.',
    'A mural painter mixes a blue that will not dry, and over the long night watches it slowly spell out the exact date of her own coming birthday.',
    'The miller opens the wooden sluice and the water runs uphill for exactly nine seconds before sheepishly remembering how gravity is supposed to work.',
    'A conductor raises her baton in the empty hall and the fine dust on the seats rises to arrange itself into neat and attentive silent rows.',
    'The glazier fits the final colored pane and sees, reflected in the bright glass, a furnished room that is definitely not behind him at all.',
    'A fisherman hauls up a heavy net full of brass clock hands, every single one of them pointing to the same and utterly impossible hour.',
    'The lighthouse stairs creak under slow footsteps that climb a full minute after the keeper has already bolted his door and gone to bed upstairs.',
    'A weaver finishes the long tapestry and notices the figure in the very center now holds something it was definitely not holding this morning.',
    'The quarry foreman splits a heavy slab and releases a trapped breath of air that smells exactly like a summer from long, long ago.',
    'A cartographer unrolls the brittle old map and finds her own small house drawn neatly in, carefully labeled with tomorrow\'s precise date.',
    'The pianist presses middle C and hears instead the distinct sound of a heavy door closing somewhere far beneath the concert hall floor.',
    'A bead curtain in the empty shop sways gently, and the shopkeeper counts exactly one more shadow than there are customers in the room.',
    'The ice sculptor steps back to admire her work and the frozen figure she carved has turned, very slightly, to face the studio door.',
    'A telegraph operator transcribes a frantic message written in a code that was officially retired long before either of them was born.',
    'The beekeeper smokes the humming hive and the rising bees spell out, for a single breath, the perfect outline of a small brass key.',
    'A cartographer\'s eraser rubs away a mountain, and from her high window she watches that very same mountain quietly vanish from view.',
    'The lantern maker lights his hundredth lamp and every single one before it flares at once, spelling a single unmistakable word: wait.',
    'A still tide pool reflects a sky full of bright stars at noon, and the child who peers in sees her own face, only very much older.',
    'The rope maker twists three long strands together and finds, knotted at the very center, a ring he buried with his brother years ago.',
    'A fresco restorer gently wipes away the grime and slowly uncovers her own unmistakable face, painted there centuries before she was born.',
  ];

  const idx = ((episodeHint - 1) * 5 + (sceneNumber - 1)) % scenes.length;
  return scenes[idx]!;
}

function episodeMetaResponse(seed: number, episodeHint: number): string {
  const titles = [
    'The Hidden Bloom Awakens',
    'A Voice From the Seed',
    'The Keeper\'s Choice',
    'Echoes in the Grove',
    'The First Promise',
    'Roots Run Deep',
    'A Bargain With Light',
    'The Path Unfolds',
    'Shadows of the Old Magic',
    'The Final Bloom',
  ];
  const hooks = [
    'A hidden seed begins to hum, calling its keeper home.',
    'The bloom speaks, but its words are not for the careless.',
    'A choice must be made before the moon sets.',
    'Voices from the past return to test the keeper\'s heart.',
    'A promise is made that cannot be unbroken.',
  ];
  const synopses = [
    'The keeper discovers a hidden seed that pulses with quiet magic, and must decide whether to share its gift or guard it alone.',
    'A voice from the bloom asks the keeper to choose between safety and song, and the choice will shape the grove for generations.',
    'The grove reveals a secret that the keeper has long suspected but never dared to speak aloud.',
    'An old friend returns with a warning, and the keeper must weigh trust against caution.',
    'The first promise is made, and its cost becomes clear only with the rising of the sun.',
  ];
  const cliffhangers = [
    'A second seed is found, glowing a different color.',
    'The keeper hears a voice she thought she would never hear again.',
    'A storm gathers on the horizon, carrying the scent of forgotten magic.',
    'Someone else has been watching the grove.',
    'The seed splits open, and something is waiting inside.',
  ];
  const idx = (episodeHint - 1) % 10;
  return JSON.stringify({
    title: pickVariation(seed + idx, titles),
    hook: pickVariation(seed + idx, hooks),
    synopsis: pickVariation(seed + idx, synopses),
    cliffhanger: pickVariation(seed + idx, cliffhangers),
    episodeSummary: pickVariation(seed + idx, synopses),
  });
}

function seoResponse(seed: number, storyTitle: string, genre: string): string {
  return JSON.stringify({
    title: `Secret ${storyTitle}`.slice(0, YOUTUBE_TITLE_MAX_LENGTH),
    description: `A magical ${genre} story told in a warm hand-painted anime style. Watch the keeper's choice unfold.`,
    tags: ['anime', 'storytime', '#shorts', 'fantasy', 'cozy'],
    thumbnailSuggestions: ['Keeper kneeling before the glowing seed', 'Grove bathed in golden light', 'Close-up of the bloom unfurling'],
    videoTemplate: '15s hook → 45s story → 5s CTA',
    hookScript: 'A hidden seed begins to hum, calling its keeper home.',
    algorithmBoostTips: ['Pin a comment with a question', 'Reply to comments in the first hour', 'Use a question in the title', 'Add a soft piano intro', 'End on a quiet cliffhanger'],
    viralPotential: 78,
    recommendedDuration: '45-60 seconds',
    targetAudience: 'Anime and cozy fantasy fans',
    trendingKeywords: ['cozy anime', 'storybook', 'magical keeper'],
    ctaScript: 'Like and subscribe for the next chapter!',
  });
}

function similarityResponse(seed: number, candidateIds: string[]): string {
  // Deterministic scores 0.0-1.0 per id
  const scores = candidateIds.map((id, i) => ({
    id,
    score: Math.min(1, 0.1 + (((seed + i * 17) % 100) / 100)),
  }));
  return JSON.stringify({ similarityScores: scores });
}

function characterBibleResponse(_seed: number): string {
  return JSON.stringify({
    speechPatterns: 'speaks softly, often trailing into song-like phrases',
    clothing: 'a moss-green cloak over a linen tunic, with a small leather satchel',
    facialFeatures: 'wide hazel eyes, a scattering of freckles, a small scar above the left brow',
    emotions: ['curious', 'gentle', 'wistful', 'quietly brave'],
    relationships: { 'elder_keeper': 'apprentice to the elder keeper', 'wanderers': 'friend to the wanderers who pass through' },
    catchphrases: ['listen with me', 'the grove will tell us'],
    physicalMannerisms: 'often kneels to examine small growing things, fingers always moving as if in tune with the wind',
  });
}

function worldBibleResponse(_seed: number): string {
  return JSON.stringify({
    antagonist: { name: 'the Hollow Keeper', motivation: 'believes the magic must remain hidden at all costs' },
    supporting: [
      { name: 'Old Winn', role: 'elder keeper', description: 'weathered and patient, hides a secret' },
      { name: 'Briar', role: 'wanderer', description: 'arrives with news from the outside world' },
    ],
    environment: {
      name: 'The Whispering Grove',
      description: 'an ancient circle of crystal-leafed trees, alive with soft light',
      type: 'forest',
      timeOfDay: 'twilight',
      weather: 'still and clear',
      mood: 'peaceful with an undercurrent of mystery',
      keyFeatures: ['crystal leaves', 'a central glowing pool', 'a stone circle'],
      colorPalette: ['#3a5a40', '#a3b18a', '#dad7cd', '#ffd6a5'],
      lighting: { primary: 'soft top-light', ambient: 'cool blue from the pool', colorTemperature: 'warm', shadows: 'soft', secondary: 'gold flecks from the seed' },
    },
  });
}

function humanizeResponse(seed: number, text: string): string {
  // Canned: lightly rephrase the input. Returned string must be same length-ish.
  // For testing, just return the input (the humanization is a no-op for canned mode).
  return text;
}

function rebalanceResponse(userPrompt: string): string {
  // Rebalance in canned mode is a no-op: extract the original scene from the
  // user prompt and return it unchanged. This preserves scene content integrity
  // since we can't do intelligent rewriting in canned mode.
  //
  // The scene is embedded as `Original scene: "<sanitizeForPrompt(scene)>"`.
  // sanitizeForPrompt escapes backslashes and quotes (`\`→`\\`, `"`→`\"`,
  // `'`→`\'`, `` ` ``→`` \` ``, `${`→`\${`), so a naive `[^"']+` capture stops
  // at the first escaped apostrophe/quote and truncates the scene. Capture
  // escape-aware (`\\.` consumes each `\X` pair; `[^"\n]` consumes the rest)
  // up to the closing bare quote, then unescape to recover the exact original.
  const match = userPrompt.match(/Original scene:\s*"((?:\\.|[^"\n])*)"/i);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : 'The scene continues as the moment unfolds.';
}

function titleUniqueResponse(seed: number): string {
  // Deterministic alternative titles so canned title-uniqueness retries return
  // valid JSON instead of the default plain-text canned message.
  const titles = [
    'A Quiet Promise',
    'The Unseen Path',
    'Threads of Light',
    'Beneath Still Waters',
    'The Last Ember',
    'A Soft Returning',
    'The Hollow Crown',
    'Woven in Starlight',
    'The Silent Oath',
    'A Fractured Key',
  ];
  return JSON.stringify({ title: pickVariation(seed, titles) });
}

function defaultResponse(_seed: number): string {
  return 'Canned response: test mode is active and no specific response shape was detected for this prompt.';
}

/**
 * Generate a deterministic canned response for the given prompts.
 * Caller must not mutate the returned string (downstream may JSON.parse it).
 */
export function cannedChatResponse(systemPrompt: string, userPrompt: string): string {
  const seed = seedFromPrompts(systemPrompt, userPrompt);
  const shape = detectShape(systemPrompt, userPrompt);
  // DEBUG: log shape detection in canned mode for diagnosis
  if (process.env.CANNED_DEBUG === '1') {
    logger.info({ module: 'canned' }, `[canned]  shape=${shape} sysLen=${systemPrompt.length} userLen=${userPrompt.length}`);
  }

  // Extract episode hint from the user prompt for scene/meta shaping
  const epMatch = userPrompt.match(/episode\s*(\d+)/i) ?? userPrompt.match(/EpisodeNumber['":\s]+(\d+)/i);
  const episodeHint = epMatch ? parseInt(epMatch[1]!, 10) : 1;

  // Extract scene number from the user prompt (format: "Scene X of 5")
  const sceneMatch = userPrompt.match(/scene\s*(\d+)\s*of\s*5/i) ?? userPrompt.match(/SceneNumber['":\s]+(\d+)/i);
  const sceneNumber = sceneMatch ? parseInt(sceneMatch[1]!, 10) : 1;

  let resp: string;
  switch (shape) {
    case 'blueprint':
      resp = blueprintResponse(seed); break;
    case 'scene':
      resp = sceneResponse(seed, episodeHint, sceneNumber); break;
    case 'episode-meta':
      resp = episodeMetaResponse(seed, episodeHint); break;
    case 'seo':
      resp = seoResponse(seed, 'Canned Story', 'fantasy'); break;
    case 'similarity': {
      // Extract candidate ids from the user prompt — they're between "IDs:" and "as"
      // L28: the /g flag made match() return full matches, so idMatch[1] was
      // the second match STRING, not a capture group. matchAll fixes it.
      const bracketMatch = userPrompt.match(/IDs?[:\s]+\[([^\]]+)\]/i);
      const quotedIds = [...userPrompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]!);
      const ids = bracketMatch?.[1]
        ? bracketMatch[1].split(',').map((s: string) => s.trim().replace(/['"]/g, ''))
        : (quotedIds.length > 0 ? quotedIds : ['canned-1', 'canned-2']);
      resp = similarityResponse(seed, ids); break;
    }
    case 'character-bible':
      resp = characterBibleResponse(seed); break;
    case 'world-bible':
      resp = worldBibleResponse(seed); break;
    case 'humanize':
      resp = humanizeResponse(seed, SCENE_BASE); break;
    case 'rebalance':
      resp = rebalanceResponse(userPrompt); break;
    case 'title-unique':
      resp = titleUniqueResponse(seed); break;
    default:
      resp = defaultResponse(seed); break;
  }
  if (process.env.CANNED_DEBUG === '1') {
    logger.info({ module: 'canned' }, `[canned]  respWords=${resp.split(/\s+/).length} respFirst80=${resp.slice(0,80).replace(/\n/g, '\\n')}`);
  }
  return resp;
}

/**
 * Deterministic 1024-dim vector derived from a text hash. Same text → same
 * vector (useful for cache parity with the real implementation).
 */
export function cannedEmbedding(text: string): number[] {
  const h = crypto.createHash('sha512').update(text.trim()).digest();
  const vec: number[] = new Array(1024);
  // Fill with deterministic pseudo-random values in [-1, 1], L2-normalized
  let sumSq = 0;
  for (let i = 0; i < 1024; i++) {
    // 4 bytes per element from the hash, repeat if hash is short
    const b1 = h[(i * 2) % h.length]!;
    const b2 = h[(i * 2 + 1) % h.length]!;
    const v = ((b1 << 8) | b2) / 32768 - 1; // [-1, 1]
    vec[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < 1024; i++) vec[i]! /= norm;
  return vec;
}

/**
 * True when STORY_TEST_MODE=canned AND the environment is non-production.
 * Routed through cannedModeEnabled() so a leaked STORY_TEST_MODE=canned in a
 * production deployment cannot swap live AI for canned responses.
 */
export function isCannedMode(): boolean {
  return cannedModeEnabled();
}
