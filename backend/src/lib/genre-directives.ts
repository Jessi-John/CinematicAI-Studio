/**
 * Genre Directives
 *
 * Centralized, testable genre instructions used by story blueprint, world bible,
 * and episode generation prompts. These directives prevent the LLM from drifting
 * into generic "cinematic mystery/horror" defaults by explicitly stating what each
 * genre must include, what it must avoid, and the expected tone.
 */

import type { Genre } from '../services/types.js';

export interface GenreDirective {
  /** Short, authoritative definition of the genre. */
  definition: string;
  /** Required narrative elements that must be present in the concept. */
  mustInclude: string[];
  /** Tropes or moods that must NOT dominate the concept. */
  mustAvoid: string[];
  /** Tone keywords that guide the writing voice. */
  tone: string[];
  /** Example themes to steer the model away from off-genre defaults. */
  exampleThemes: string[];
  /** Notes on what kind of antagonist/conflict is appropriate. */
  conflictNotes: string;
  /** Notes on what kind of setting is appropriate. */
  settingNotes: string;
}

const BASELINE: GenreDirective = {
  definition: 'A cinematic anime-style story suitable for YouTube Shorts.',
  mustInclude: ['a relatable protagonist aged 10-22', 'a clear emotional through-line'],
  mustAvoid: ['graphic violence, gore, sexual content, slurs, self-harm', 'copyrighted characters or settings'],
  tone: ['evocative', 'cinematic'],
  exampleThemes: ['trust after loss', 'courage in the unfamiliar'],
  conflictNotes: 'Use a conflict appropriate to the genre.',
  settingNotes: 'Choose a setting that reinforces the genre.',
};

const SHARED_YOUTUBE_RULES = [
  'No graphic violence, gore, sexual content, slurs, or self-harm depiction.',
  'No drug/weapon glorification. No real-person impersonation.',
  'Themes suitable for a general YouTube Shorts audience.',
];

export const GENRE_DIRECTIVES: Record<Genre, GenreDirective> = {
  fantasy: {
    definition: 'Fantasy: a story where magic, myth, or the impossible are real and central to the plot.',
    mustInclude: ['a magical system or fantastical element', 'a sense of wonder or mythic stakes', 'a protagonist who is changed by the impossible'],
    mustAvoid: ['sci-fi technology or space travel', 'pure horror without wonder', 'real-world modern settings without magical intrusion'],
    tone: ['wonderful', 'mythic', 'atmospheric', 'high-stakes'],
    exampleThemes: ['finding courage in the unknown', 'the cost of magic', 'legacy and light'],
    conflictNotes: 'The conflict should be magical or mythic in nature (e.g., a cursed artifact, a fading enchantment, a forgotten prophecy).',
    settingNotes: 'Use an enchanted or mythic setting: floating islands, ancient forests, ruins, villages built on impossible architecture.',
  },
  adventure: {
    definition: 'Adventure: a story driven by exploration, discovery, and a journey into the unknown.',
    mustInclude: ['a journey, expedition, or physical quest', 'discovery of something unknown', 'danger and wonder in equal measure'],
    mustAvoid: ['domestic settings with no travel or exploration', 'pure romance or comedy as the primary engine', 'horror without discovery'],
    tone: ['bold', 'restless', 'awe-filled', 'tense'],
    exampleThemes: ['the unknown rewards the brave', 'maps that lead to more than treasure', 'friendship forged on the road'],
    conflictNotes: 'The conflict comes from the environment, the journey, or rivals for a discovered secret.',
    settingNotes: 'Use an exotic or expansive location: coasts, ruins, jungles, skies, underground cities, lost frontiers.',
  },
  romance: {
    definition: 'Romance: a story where a developing love relationship is the central engine of the plot and emotional stakes.',
    mustInclude: [
      'a clear love interest or romantic connection',
      'romantic tension, longing, or emotional intimacy',
      'a relationship that grows or is tested across episodes',
      'a theme about love, connection, vulnerability, or trust',
      'the protagonist and love interest share scenes that move the relationship forward',
    ],
    mustAvoid: [
      'making the love interest a mystery, horror, or action prop',
      'absence of any emotional or romantic development',
      'pure adventure, horror, or thriller with no romantic heart',
      'supernatural phenomena that replace the romantic relationship as the focus',
    ],
    tone: ['tender', 'longing', 'warm', 'intimate', 'bittersweet'],
    exampleThemes: [
      'love found in the place you least expected',
      'the courage to be vulnerable with someone new',
      'two people separated by circumstance find their way back',
      'a quiet crush that becomes something real',
    ],
    conflictNotes: 'The conflict should threaten or test the romantic bond (e.g., distance, misunderstanding, sacrifice, external opposition, timing). The love interest must be a person, not a phenomenon.',
    settingNotes: 'Use settings that invite closeness and longing: gardens, cafes, train stations, rooftops, beaches, rainy streets, libraries, a shared workplace.',
  },
  horror: {
    definition: 'Horror: a story designed to evoke fear, dread, or unease through a threatening presence or situation.',
    mustInclude: ['a source of fear or dread', 'atmosphere that builds unease', 'a protagonist in vulnerable or mortal peril'],
    mustAvoid: ['comedic tone or slapstick', 'action without dread', 'romance that distracts from the threat'],
    tone: ['dread-filled', 'oppressive', 'uncanny', 'visceral'],
    exampleThemes: ['the thing that watches back', 'fear of being unseen', 'some doors should stay closed'],
    conflictNotes: 'The conflict is survival against a supernatural, psychological, or monstrous threat.',
    settingNotes: 'Use isolating, decaying, or claustrophobic settings: abandoned buildings, fogbound towns, empty roads, dark forests.',
  },
  mystery: {
    definition: 'Mystery: a story built around a puzzle, crime, or unexplained event that the protagonist must investigate and solve.',
    mustInclude: ['a clear puzzle, question, or crime to solve', 'clues or evidence that point toward an answer', 'a protagonist who investigates'],
    mustAvoid: ['pure horror where the goal is only survival', 'supernatural answers without a solvable puzzle', 'romance or comedy that overshadows the mystery'],
    tone: ['inquisitive', 'suspenseful', 'methodical', 'shadowy'],
    exampleThemes: ['the truth hides in plain sight', 'every witness lies a little', 'the past refuses to stay buried'],
    conflictNotes: 'The conflict is the protagonist versus an unknown truth or hidden antagonist; clues must be meaningful.',
    settingNotes: 'Use settings that reward investigation: old libraries, observatories, foggy harbors, manor houses, archives.',
  },
  thriller: {
    definition: 'Thriller: a story of sustained tension, danger, and high stakes where the protagonist faces an immediate threat.',
    mustInclude: ['a clear, immediate threat or danger', 'suspense and escalating tension', 'a protagonist with limited time or options'],
    mustAvoid: ['slow, atmospheric mystery without urgency', 'pure horror dread without plot momentum', 'comedic relief that breaks tension'],
    tone: ['tense', 'relentless', 'paranoid', 'urgent'],
    exampleThemes: ['the clock is running out', 'trust no one', 'one wrong move and everything falls apart'],
    conflictNotes: 'The conflict is immediate and personal: pursuit, conspiracy, assassination, or a race against time.',
    settingNotes: 'Use high-pressure locations: cities at night, subways, rooftops, secure facilities, storm-lashed coasts.',
  },
  'sci-fi': {
    definition: 'Science fiction: a story where technology, space, time, or speculative science drives the plot and worldbuilding.',
    mustInclude: ['a science-fiction element (technology, AI, space, time, alternate science)', 'speculative "what if" premise', 'consequences of that technology or science'],
    mustAvoid: ['magic or myth presented as science', 'pure fantasy without technological grounding', 'settings that ignore the sci-fi premise'],
    tone: ['speculative', 'cool', 'intellectual', 'awe-struck'],
    exampleThemes: ['the signal that should not exist', 'machines that remember better than we do', 'the last archive of Earth'],
    conflictNotes: 'The conflict arises from the technology, its misuse, or its unintended consequences.',
    settingNotes: 'Use futuristic or speculative settings: arcologies, space stations, abandoned labs, orbital habitats, neon cities.',
  },
  drama: {
    definition: 'Drama: a grounded, character-driven story about human relationships, choices, and emotional consequences.',
    mustInclude: [
      'realistic human conflict or emotional stakes',
      'relationships that matter and are tested',
      'character choices with meaningful consequences',
      'a theme about family, identity, ambition, grief, or reconciliation',
      'NO supernatural or magical solutions to the conflict',
    ],
    mustAvoid: [
      'supernatural or magical elements that solve the conflict',
      'horror or thriller threats that override the human story',
      'comedy as the primary mode',
      'science-fiction or fantasy worldbuilding that distracts from the emotional core',
      'impossible architecture, hidden doors to other worlds, or cursed objects',
    ],
    tone: ['earnest', 'grounded', 'intimate', 'bittersweet'],
    exampleThemes: [
      'the silence between family members',
      'ambition versus belonging',
      'grief that reshapes a family',
      'a secret that can no longer stay hidden',
    ],
    conflictNotes: 'The conflict is interpersonal or internal: a family rift, a moral choice, a secret, a lost opportunity, a strained friendship, or a life transition. If the seed mentions "something unexpected," make it emotional and human (e.g., a letter, a confession, a discovery about a loved one), never magical or supernatural.',
    settingNotes: 'Use grounded, recognizable settings: a family home, a school, a neighborhood, a workplace, a hospital, a café, a bus stop.',
  },
  comedy: {
    definition: 'Comedy: a story designed to amuse the audience through humor, wit, funny situations, and comedic timing.',
    mustInclude: [
      'genuine comedic situations or jokes',
      'a humorous premise, misunderstanding, or character quirk',
      'lighthearted or satirical tone',
      'a comedic payoff or running gag',
      'the protagonist reacts to absurdity in a way that is funny, not frightening',
    ],
    mustAvoid: [
      'horror, dread, or existential terror',
      'death, gore, or life-threatening danger as the focus',
      'surreal horror or uncanny atmosphere',
      'melodrama or tragedy',
      'mystery phantoms, ghosts, curses, or supernatural stalkers as the main plot',
    ],
    tone: ['playful', 'witty', 'absurd', 'lighthearted', 'warm'],
    exampleThemes: [
      'a small disaster that keeps getting funnier',
      'the rivalry that turns into friendship',
      'the talent show that goes wrong in the best way',
      'a misunderstanding that spirals into chaos',
    ],
    conflictNotes: 'The conflict should be comedic: a misunderstanding, a competition, a series of escalating mishaps, social awkwardness, a prank war, or a harmless obsession. If the seed mentions "something unexpected," make it funny and embarrassing, not scary or magical.',
    settingNotes: 'Use everyday or slightly absurd settings: a school, a cafe, a laundromat, a family kitchen, a talent show, a neighborhood, a part-time job.',
  },
  action: {
    definition: 'Action: a story where physical conflict, chases, combat, or heroic feats drive the plot forward.',
    mustInclude: ['physical action or conflict', 'a clear antagonist or obstacle to overcome', 'stakes that are personal and immediate'],
    mustAvoid: ['mystery without action', 'romance that dominates the plot', 'horror dread without momentum'],
    tone: ['kinetic', 'intense', 'heroic', 'driven'],
    exampleThemes: ['the last stand of the outnumbered', 'a chase through a city that never sleeps', 'proving yourself when it counts'],
    conflictNotes: 'The conflict is physical and external: combat, pursuit, rescue, or a contest of skill and courage.',
    settingNotes: 'Use locations that enable movement and spectacle: rooftops, market streets, trains, arenas, storm-tossed ships.',
  },
  emotional: {
    definition: 'Emotional: a story centered on deep feeling, catharsis, human connection, and heartfelt transformation.',
    mustInclude: ['a strong emotional core', 'a moment of connection, loss, or healing', 'a protagonist with a vulnerable inner life'],
    mustAvoid: ['action or horror that overshadows the emotional journey', 'supernatural spectacle without feeling', 'detached, ironic tone'],
    tone: ['tender', 'heartfelt', 'melancholic', 'hopeful'],
    exampleThemes: ['learning to say goodbye', 'the kindness of a stranger', 'finding hope after grief'],
    conflictNotes: 'The conflict is emotional: grief, loneliness, regret, forgiveness, or the difficulty of connection.',
    settingNotes: 'Use settings that amplify feeling: a quiet harbor, a rainy street, a childhood home, a hospital waiting room, a letter found in a coat.',
  },
  mythology: {
    definition: 'Mythology: a story inspired by myth, legend, or epic tales, often involving gods, fate, or cosmic stakes.',
    mustInclude: ['mythic or legendary elements', 'cosmic, fated, or epic stakes', 'a protagonist who defies or fulfills destiny'],
    mustAvoid: ['modern mundane settings without mythic intrusion', 'sci-fi tech replacing mythic wonder', 'small stakes that feel contemporary'],
    tone: ['reverent', 'epic', 'timeless', 'fateful'],
    exampleThemes: ['the echo of an old god', 'a promise made to the underworld', 'the price of defying fate'],
    conflictNotes: 'The conflict involves fate, divine will, legacy, or a mythic bargain.',
    settingNotes: 'Use mythic settings: ancient temples, floating islands, the underworld, celestial courts, forgotten empires.',
  },
  historical: {
    definition: 'Historical fiction: a story set in a recognizable past era, grounded in period detail and atmosphere.',
    mustInclude: ['a specific past-era setting', 'period-appropriate details and atmosphere', 'a conflict that arises from the era or its social conditions'],
    mustAvoid: ['modern technology or anachronisms', 'magic or sci-fi as the primary driver', 'generic fantasy settings'],
    tone: ['period-evocative', 'restrained', 'immersive', 'reflective'],
    exampleThemes: ['a map that redraws the known world', 'a letter that arrives too late', 'the last apprentice of a dying craft'],
    conflictNotes: 'The conflict is shaped by the era: war, social change, a lost craft, a forbidden discovery, a political secret.',
    settingNotes: 'Use historically evocative locations: a cartographer\'s guild, a wartime city, a steamship, an ancient library, a workshop.',
  },
  'slice-of-life': {
    definition: 'Slice-of-life: a story about everyday life, mundane routines, and small but meaningful emotional experiences.',
    mustInclude: [
      'ordinary, recognizable daily life',
      'small emotional stakes and quiet character moments',
      'relationships, routines, or personal growth',
      'a theme about finding wonder in the ordinary',
      'NO supernatural or magical explanations for events',
    ],
    mustAvoid: [
      'supernatural or magical elements',
      'horror, dread, or danger',
      'epic stakes or world-saving plots',
      'mystery or thriller elements',
      'ghosts, curses, portals, parallel worlds, or impossible phenomena',
    ],
    tone: ['gentle', 'warm', 'grounded', 'nostalgic', 'quiet'],
    exampleThemes: [
      'a friendship that begins over lunch',
      'learning to ride a bike at any age',
      'the last day at a favorite spot',
      'a small kindness that changes a routine',
      'a family recipe that carries memory',
    ],
    conflictNotes: 'The conflict is small and personal: a misunderstanding, a change, a fear, a quiet decision, a growing-up moment, or a bridge between two people. If the seed mentions "something unexpected," make it ordinary and human (e.g., a forgotten letter, a new neighbor, a change in routine), never magical.',
    settingNotes: 'Use cozy, everyday settings: a school, a family kitchen, a park bench, a neighborhood shop, a bedroom at dusk, a riverside path, a community garden.',
  },
  'dark-fantasy': {
    definition: 'Dark fantasy: a fantasy story with grim, dangerous, or morally complex magical elements.',
    mustInclude: ['a corrupted, dangerous, or morally ambiguous magical element', 'real stakes and a sense of peril', 'a world where magic has a cost'],
    mustAvoid: ['whimsical wonder without danger', 'pure horror without fantasy worldbuilding', 'sci-fi technology'],
    tone: ['brooding', 'ominous', 'grim', 'wonder-touched'],
    exampleThemes: ['the last ember of a dead kingdom', 'grief as a crucible', 'a bargain with something ancient'],
    conflictNotes: 'The conflict is magical and dangerous: a cursed bloodline, a dying magic, a predator from the old world.',
    settingNotes: 'Use decaying or dangerous magical settings: drowned foundries, cursed forests, crumbling castles, ash-choked ruins.',
  },
  psychological: {
    definition: 'Psychological: a story focused on mental conflict, perception, obsession, or the unreliability of reality.',
    mustInclude: ['a mental or perceptual conflict', 'uncertainty about what is real', 'a protagonist whose mind or perception is under pressure'],
    mustAvoid: ['pure physical action or combat', 'clear supernatural manifestation without psychological ambiguity', 'comedic tone'],
    tone: ['uncanny', 'claustrophobic', 'obsessive', 'unsettling'],
    exampleThemes: ['the reflection that is not you', 'the memory that keeps changing', 'the game with no rules'],
    conflictNotes: 'The conflict is internal or perceptual: obsession, paranoia, identity, guilt, or a mind under siege.',
    settingNotes: 'Use locations that mirror mental states: mirror halls, empty apartments, repetitive corridors, offices at night, fogged glass.',
  },
  inspirational: {
    definition: 'Inspirational: an uplifting story about hope, perseverance, personal growth, or discovering wonder in adversity.',
    mustInclude: ['a protagonist facing a challenge or low point', 'a moment of hope, growth, or renewed courage', 'an uplifting theme'],
    mustAvoid: ['dark, hopeless endings', 'horror or dread as the primary tone', 'cynicism or nihilism'],
    tone: ['hopeful', 'warm', 'earnest', 'uplifting'],
    exampleThemes: ['finding light in the ordinary', 'the second chance you did not expect', 'small courage becomes something bigger'],
    conflictNotes: 'The conflict is a challenge the protagonist must overcome: self-doubt, loss, isolation, or a difficult choice.',
    settingNotes: 'Use settings that suggest renewal and possibility: a sunlit street after rain, a community garden, a quiet workshop, a hillside at dawn.',
  },
  kids: {
    definition: 'Kids: a child-friendly story of wonder, friendship, and simple adventure with age-appropriate stakes.',
    mustInclude: ['a child or young teen protagonist', 'wonder, friendship, or gentle adventure', 'age-appropriate stakes and emotions', 'a clear, reassuring resolution arc'],
    mustAvoid: ['genuine horror, gore, or existential dread', 'romantic subplots', 'violence or death', 'cynicism or dark themes'],
    tone: ['wonderful', 'playful', 'gentle', 'hopeful'],
    exampleThemes: ['a backyard that becomes a kingdom', 'the friendship that begins with a lost pet', 'curiosity unlocks a small wonder'],
    conflictNotes: 'The conflict is gentle and solvable: a misunderstanding, a lost item, a friendly challenge, a small fear to overcome.',
    settingNotes: 'Use child-friendly, familiar settings: a backyard, a treehouse, a classroom, a park, a family home, a neighborhood.',
  },
  survival: {
    definition: 'Survival: a story about enduring hostile environments, scarcity, disaster, or life-threatening circumstances.',
    mustInclude: ['a hostile environment or disaster', 'scarcity, danger, or isolation', 'a protagonist fighting to endure'],
    mustAvoid: ['romance or comedy as the primary engine', 'supernatural horror without survival stakes', 'civilized comfort that removes the threat'],
    tone: ['harsh', 'tenacious', 'isolating', 'grim but hopeful'],
    exampleThemes: ['the last green light in a drowned world', 'hope in forgotten places', 'the will to outlast the storm'],
    conflictNotes: 'The conflict is the environment itself: weather, terrain, starvation, isolation, or the aftermath of disaster.',
    settingNotes: 'Use hostile, resource-scarce locations: flooded ruins, frozen forests, deserts, wrecked ships, post-disaster cities.',
  },
  'anime-style': {
    definition: 'Anime-style: a story that embraces anime storytelling conventions — emotional intensity, visual symbolism, stylized worlds, and heartfelt coming-of-age themes.',
    mustInclude: ['emotional intensity and earnestness', 'visual symbolism (light, weather, color)', 'a coming-of-age or self-discovery arc', 'stylized but coherent world logic'],
    mustAvoid: ['generic live-action realism', 'detached or cynical tone', 'horror or action that overrides emotional growth'],
    tone: ['earnest', 'stylized', 'emotionally vivid', 'wonder-tinged'],
    exampleThemes: ['a glowing mark that appears at the shore', 'the promise made under cherry blossoms', 'the friend who sees your light'],
    conflictNotes: 'The conflict is personal and emotionally resonant: identity, belonging, a hidden gift, or a fated connection.',
    settingNotes: 'Use evocative anime locations: rooftops, train stations, beaches at sunset, school festivals, cherry-tree paths.',
  },
  'viral-trend': {
    definition: 'Viral-trend: a modern, highly shareable story built on a relatable internet-age hook — a viral video, a trending challenge, an unexpected moment of online fame — that compels viewers to watch, comment, and share.',
    mustInclude: [
      'a modern, online element (a phone, app, livestream, video, post, or social platform)',
      'a relatable everyday protagonist',
      'an escalation driven by public attention — views, comments, shares, or people showing up',
      'a shareable payoff or twist grounded in the real world',
    ],
    mustAvoid: [
      'supernatural horror, ghosts, curses, haunted objects, or demonic forces',
      'gore, blood, or dread-heavy menace',
      'historical, fantasy, or mythological settings',
      'slow pacing or heavy exposition',
    ],
    tone: ['punchy', 'modern', 'relatable', 'curiosity-driven', 'fast-paced'],
    exampleThemes: [
      'the livestream that accidentally went viral overnight',
      'the recipe video the whole internet argued about',
      'the trend that showed up at her door',
    ],
    conflictNotes: 'The conflict comes from public attention and modern life: comments, views, rivals, skeptics, or the pressure of going viral — never from supernatural forces.',
    settingNotes: 'Use modern, relatable locations: kitchens, bedrooms, phones, city streets, cafes, campuses, screens.',
  },
};

export function getGenreDirective(genre: string): GenreDirective {
  const normalized = genre.toLowerCase() as Genre;
  return GENRE_DIRECTIVES[normalized] ?? BASELINE;
}

export function formatGenreDirective(genre: string): string {
  const d = getGenreDirective(genre);
  const lines = [
    `GENRE DEFINITION: ${d.definition}`,
    '',
    'REQUIRED ELEMENTS (must all be present in the concept):',
    ...d.mustInclude.map((item) => `- ${item}`),
    '',
    'FORBIDDEN ELEMENTS (must NOT dominate the story):',
    ...d.mustAvoid.map((item) => `- ${item}`),
    '',
    'TONE:',
    ...d.tone.map((item) => `- ${item}`),
    '',
    'APPROPRIATE THEMES:',
    ...d.exampleThemes.map((item) => `- ${item}`),
    '',
    `CONFLICT: ${d.conflictNotes}`,
    `SETTING: ${d.settingNotes}`,
    '',
    'YOUTUBE MONETIZATION RULES:',
    ...SHARED_YOUTUBE_RULES.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export function formatGenreDirectiveForEpisode(genre: string): string {
  const d = getGenreDirective(genre);
  const lines = [
    `GENRE: ${genre}`,
    `DEFINITION: ${d.definition}`,
    `REQUIRED: ${d.mustInclude.join('; ')}`,
    `AVOID: ${d.mustAvoid.join('; ')}`,
    `TONE: ${d.tone.join(', ')}`,
    `CONFLICT: ${d.conflictNotes}`,
    `SETTING: ${d.settingNotes}`,
  ];
  return lines.join('\n');
}

export function isGenreDirectiveKnown(genre: string): boolean {
  return (genre.toLowerCase() as Genre) in GENRE_DIRECTIVES;
}

export const KNOWN_GENRES: readonly Genre[] = Object.freeze(Object.keys(GENRE_DIRECTIVES) as Genre[]);
