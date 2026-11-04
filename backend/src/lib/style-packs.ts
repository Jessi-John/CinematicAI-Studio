/**
 * Genre-aware Style Packs
 *
 * Every style pack inherits a Ghibli-inspired cinematic baseline (warm watercolor,
 * painterly, expressive eyes, ambient particles) and overrides genre-specific
 * art direction, lighting, palette, motion vocabulary, and music/sound design.
 *
 * Used by lib/prompt-engine.ts to produce per-scene image and video prompts
 * that look right for the actual genre instead of a forest-watercolor template.
 */

import type { Genre } from '../services/types.js';

export interface StylePack {
  // Visual direction (image prompts)
  artDirection: string;
  lightingPalette: string;
  colorPalette: string[];
  textureDepth: string;
  shadowStyle: 'soft' | 'hard' | 'dramatic';
  // Motion / cinematography (video prompts)
  cameraVocabulary: string[];
  motionVocabulary: string;
  atmosphericEffects: string[];
  transitionStyle: string;
  // Audio direction
  musicMoods: string[];
  soundDesign: string[];
  // Tone / mood
  moodWords: string[];
  // What environment this genre defaults to (used as a fallback)
  defaultEnvironment: {
    type: string;
    weather: string;
    keyFeatures: string[];
    colorPalette: string[];
    timeOfDay: string;
  };
  // Anti-patterns that destroy the genre's look
  forbiddenStyleTerms: string[];
}

const GHIBLI_BASELINE = {
  textureDepth: 'painterly textures with watercolor depth, hand-drawn linework, rich atmospheric layering',
  cameraVocabulary: [
    'slow push-in on subject',
    'wide establishing shot with subtle parallax',
    'tracking shot following movement',
    'low angle for emphasis',
    'over-the-shoulder for emotional tension',
  ],
  atmosphericEffects: [
    'floating particles and ambient dust',
    'soft volumetric light rays',
    'gentle parallax background layers',
    'subtle environmental motion',
  ],
  transitionStyle: 'soft dissolve with motion continuity',
};

export const STYLE_PACKS: Record<Genre, StylePack> = {
  fantasy: {
    artDirection:
      'hand-painted watercolor anime, soft cel-shaded characters, ethereal atmosphere, warm painterly cinematic aesthetic without copying any IP',
    lightingPalette: 'warm golden hour, godrays through canopy, soft volumetric haze',
    colorPalette: ['soft greens', 'warm golds', 'mystic blues', 'earth browns'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: GHIBLI_BASELINE.cameraVocabulary,
    motionVocabulary:
      'gentle character motion, hair and cloth flowing in breeze, floating motes of light, foliage swaying softly',
    atmosphericEffects: [
      'floating pollen and dust motes',
      'magical light particles',
      'wind-swept leaves',
      'glowing mist',
    ],
    transitionStyle: 'soft watercolor dissolve',
    musicMoods: [
      'gentle piano with strings',
      'building orchestral with celesta',
      'mysterious flute and harp',
      'emotional crescendo with woodwinds',
      'peaceful harp resolution',
    ],
    soundDesign: [
      'wind through leaves, distant bird calls',
      'magical chime, footfalls on moss',
      'whispers, ambient glow',
      'rising wind, stone settling',
      'soft silence, leaves drifting',
    ],
    moodWords: ['nostalgic wonder', 'mystical hush', 'gentle awe', 'quiet magic'],
    defaultEnvironment: {
      type: 'fantasy nature',
      weather: 'clear with gentle mist',
      keyFeatures: ['ancient trees', 'glowing streams', 'floating fireflies', 'mossy ruins'],
      colorPalette: ['soft greens', 'warm golds', 'mystic blues'],
      timeOfDay: 'golden morning',
    },
    forbiddenStyleTerms: ['cyberpunk', 'neon', 'photorealistic', 'horror'],
  },
  adventure: {
    artDirection:
      'painterly anime adventure illustration, kinetic linework, dynamic composition with depth',
    lightingPalette: 'high-contrast natural light, dramatic backlight, rich sky gradients',
    colorPalette: ['vivid sky blues', 'sun-baked terracotta', 'sail whites', 'forest greens'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: [
      'aerial drone-style sweep',
      'tracking shot following the hero',
      'low-angle hero shot against the sky',
      'wide establishing shot with depth',
      'whip pan into action',
    ],
    motionVocabulary:
      'characters moving with purpose, sails snapping, ropes swinging, dust kicked up by footfalls',
    atmosphericEffects: [
      'wind-swept particles',
      'rolling clouds',
      'spray and mist',
      'birds in flight',
    ],
    transitionStyle: 'kinetic match-cut on movement',
    musicMoods: [
      'sweeping adventure orchestra',
      'percussive marching cue',
      'tense pursuit strings',
      'triumphant brass swell',
      'reflective acoustic guitar',
    ],
    soundDesign: [
      'wind, footfalls on dirt, distant calls',
      'creaking ropes, sails snapping',
      'rushing water, paddle strokes',
      'metal on stone, breath',
      'fire crackle, settling silence',
    ],
    moodWords: ['restless curiosity', 'open horizon', 'urgent forward motion'],
    defaultEnvironment: {
      type: 'open exterior',
      weather: 'clear with rolling clouds',
      keyFeatures: ['mountain ridges', 'rope bridges', 'distant horizon', 'weathered ruins'],
      colorPalette: ['sky blue', 'terracotta', 'forest green'],
      timeOfDay: 'late afternoon',
    },
    forbiddenStyleTerms: ['horror', 'cute kawaii', 'photorealistic'],
  },
  romance: {
    artDirection:
      'soft painterly anime, intimate close-ups, shallow depth, expressive eyes, warm pastel mood',
    lightingPalette: 'warm rim light, soft window light, candlelight, sunset glow',
    colorPalette: ['warm pinks', 'creamy whites', 'soft golds', 'dusty roses'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: [
      'slow dolly-in on faces',
      'over-the-shoulder eyeline',
      'shallow depth close-up',
      'rack focus between subjects',
      'soft handheld intimate framing',
    ],
    motionVocabulary:
      'subtle gestures, eyes meeting and looking away, hair stirring in breeze, slow breath',
    atmosphericEffects: [
      'lens-flare bokeh',
      'soft floating petals',
      'curtains stirring',
      'falling snow or rain',
    ],
    transitionStyle: 'tender soft dissolve',
    musicMoods: [
      'gentle solo piano',
      'warm string quartet',
      'acoustic guitar with cello',
      'building emotional swell',
      'whispered piano outro',
    ],
    soundDesign: [
      'breath, distant chatter',
      'soft footsteps, fabric',
      'rain on window, heart-beat',
      'warm room tone, fireplace',
      'soft music box, silence',
    ],
    moodWords: ['tender', 'aching', 'hopeful', 'bittersweet'],
    defaultEnvironment: {
      type: 'intimate interior or seasonal exterior',
      weather: 'gentle seasonal',
      keyFeatures: ['warm window light', 'wooden floors', 'soft textiles', 'flowering branches'],
      colorPalette: ['warm pink', 'cream', 'gold'],
      timeOfDay: 'golden hour',
    },
    forbiddenStyleTerms: ['horror', 'gore', 'cyberpunk'],
  },
  horror: {
    artDirection:
      'painterly anime horror, high contrast, desaturated palette, unsettling negative space, sharp linework, no gore',
    lightingPalette: 'low-key chiaroscuro, harsh single-source, cold moonlight, flickering practical lights',
    colorPalette: ['cold blues', 'desaturated greens', 'deep blacks', 'sickly yellows'],
    textureDepth: 'painterly textures with grime and dust, scratched negatives feel',
    shadowStyle: 'dramatic',
    cameraVocabulary: [
      'slow creep-in static frame',
      'low-angle dread shot',
      'over-the-shoulder reveal',
      'handheld shaky discomfort',
      'long-take corridor push',
    ],
    motionVocabulary:
      'unsettling stillness, slow inhuman motion, sudden snap of head, breath fogging cold air',
    atmosphericEffects: [
      'rolling fog at floor level',
      'flickering lights',
      'dust motes in dim beams',
      'curtains stirring without wind',
    ],
    transitionStyle: 'hard cut on tension beat or slow dissolve into black',
    musicMoods: [
      'low drone with distant strings',
      'broken music-box motif',
      'tense pulsing bass',
      'silent build with sudden hit',
      'dying piano resolution',
    ],
    soundDesign: [
      'wind, distant creak, dripping water',
      'whispers, footsteps, slow breath',
      'static, ringing tone',
      'sudden silence then hit',
      'heartbeat fading to nothing',
    ],
    moodWords: ['dread', 'unease', 'cold attention', 'inevitable'],
    defaultEnvironment: {
      type: 'haunted interior or cold exterior',
      weather: 'overcast with mist',
      keyFeatures: ['peeling wallpaper', 'broken mirrors', 'long shadows', 'creaking floorboards'],
      colorPalette: ['cold blue', 'desaturated green', 'deep black'],
      timeOfDay: 'late night',
    },
    forbiddenStyleTerms: ['cute kawaii', 'pastel', 'rainbow', 'photorealistic gore'],
  },
  mystery: {
    artDirection:
      'painterly anime noir-tinted, balanced negative space, careful framing, expressive but contained',
    lightingPalette: 'practical lamps, rim light through blinds, cool ambient, warm key',
    colorPalette: ['cool blues', 'amber pools', 'paper whites', 'shadow blacks'],
    textureDepth: 'painterly with crisp linework, paper-grain background',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'slow dolly-in over evidence',
      'high-angle table shot',
      'eyeline rack focus',
      'long static observation frame',
      'whip pan to reveal',
    ],
    motionVocabulary:
      'precise hand movements, lifting a page, pulling a thread, eyes tracking detail',
    atmosphericEffects: [
      'dust in lamp beams',
      'rain on windows',
      'cigar smoke or steam',
      'shifting light through blinds',
    ],
    transitionStyle: 'match-cut on object or hard cut on revelation',
    musicMoods: [
      'sparse jazz piano',
      'tense pizzicato strings',
      'ambient pulse',
      'building investigative motif',
      'resolved cool theme',
    ],
    soundDesign: [
      'ticking clock, distant traffic',
      'paper rustle, page turn',
      'rain on glass, footsteps',
      'phone receiver, silence',
      'door closing softly',
    ],
    moodWords: ['suspicion', 'patient observation', 'cold logic', 'reveal'],
    defaultEnvironment: {
      type: 'cluttered interior or rain-slick exterior',
      weather: 'rainy or overcast',
      keyFeatures: ['scattered evidence', 'window blinds', 'hand-written notes', 'old photographs'],
      colorPalette: ['cool blue', 'amber', 'paper white'],
      timeOfDay: 'late evening',
    },
    forbiddenStyleTerms: ['kawaii', 'rainbow', 'pastel'],
  },
  thriller: {
    artDirection:
      'painterly anime kinetic, cool grades, sharp contrast, urgent compositions, sleek modern feel',
    lightingPalette: 'cool key light, neon practicals, hard side light, urban sodium',
    colorPalette: ['steel blues', 'concrete grays', 'red accent', 'asphalt black'],
    textureDepth: 'painterly with cinematic grain',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'handheld pursuit',
      'whip pan into reveal',
      'low-angle running shot',
      'dutch tilt for tension',
      'tracking sprint',
    ],
    motionVocabulary:
      'urgent running, glancing back, fingers fumbling at locks, breath visible in cold air',
    atmosphericEffects: [
      'rain in headlight beams',
      'flickering neon',
      'breath in cold air',
      'sparks from glancing impact',
    ],
    transitionStyle: 'hard cut on impact or whip pan',
    musicMoods: [
      'pulsing synth bass',
      'driving percussion',
      'tense string ostinato',
      'silent breath then hit',
      'cold synth aftermath',
    ],
    soundDesign: [
      'ragged breath, footfalls',
      'distant siren, traffic',
      'metal scrape, tires',
      'sudden silence, heartbeat',
      'cold wind, alarm fading',
    ],
    moodWords: ['urgent', 'cornered', 'pursued', 'razor focus'],
    defaultEnvironment: {
      type: 'urban exterior or sterile interior',
      weather: 'rainy night',
      keyFeatures: ['neon signs', 'wet asphalt', 'fire escapes', 'concrete corridors'],
      colorPalette: ['steel blue', 'concrete gray', 'red accent'],
      timeOfDay: 'rain-slick night',
    },
    forbiddenStyleTerms: ['cute', 'pastel', 'cottagecore'],
  },
  'sci-fi': {
    artDirection:
      'painterly anime sci-fi, sleek metallic surfaces, holographic interfaces, soft volumetric haze',
    lightingPalette: 'cool rim light, holographic glow, neon practicals, deep-space ambient',
    colorPalette: ['cyan', 'magenta', 'cool whites', 'deep navy'],
    textureDepth: 'painterly with metallic sheen and subtle scanlines',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'slow orbit around hardware',
      'wide vista with parallax stars',
      'tight inserts on glowing UI',
      'tracking through corridor',
      'low-angle ship reveal',
    ],
    motionVocabulary:
      'precise mechanical motion, holographic displays unfolding, rotating gimbals, hovering drones',
    atmosphericEffects: [
      'holographic particles',
      'volumetric haze in light beams',
      'data motes',
      'distant engine glow',
    ],
    transitionStyle: 'glitch wipe or smooth orbit transition',
    musicMoods: [
      'ambient synth pads',
      'pulsing arpeggio',
      'orchestral with electronics',
      'tense low-end build',
      'reflective sustain',
    ],
    soundDesign: [
      'low engine hum, fans',
      'beeps and confirms',
      'pneumatic hiss, doors',
      'comms static, breath',
      'distant rumble, silence',
    ],
    moodWords: ['cold awe', 'precise', 'distant', 'discovery'],
    defaultEnvironment: {
      type: 'spacecraft interior or alien vista',
      weather: 'controlled atmosphere',
      keyFeatures: ['holographic panels', 'metal corridors', 'starfield viewport', 'modular consoles'],
      colorPalette: ['cyan', 'magenta', 'cool white'],
      timeOfDay: 'artificial cycle',
    },
    forbiddenStyleTerms: ['watercolor pastoral', 'cottagecore', 'medieval fantasy'],
  },
  drama: {
    artDirection:
      'painterly anime drama, restrained palette, lived-in spaces, expressive faces, subtle color storytelling',
    lightingPalette: 'natural soft light, practical lamps, evening windows, overcast diffuse',
    colorPalette: ['muted earth', 'warm amber', 'cool gray', 'paper white'],
    textureDepth: 'painterly with lived-in texture and grain',
    shadowStyle: 'soft',
    cameraVocabulary: [
      'long static observation',
      'subtle dolly on emotion',
      'over-the-shoulder dialogue',
      'wide two-shot with space',
      'slow pull-back to context',
    ],
    motionVocabulary:
      'small honest gestures, fingers fidgeting, breath catching, eyes lowering',
    atmosphericEffects: [
      'dust in window light',
      'curtains stirring',
      'rain or snow outside the window',
      'steam rising from a cup',
    ],
    transitionStyle: 'soft dissolve on emotional beat',
    musicMoods: [
      'solo piano',
      'cello with strings',
      'sparse acoustic guitar',
      'gentle orchestral',
      'reflective silence',
    ],
    soundDesign: [
      'room tone, distant chatter',
      'tea cup, paper',
      'rain on window',
      'breath, ticking clock',
      'door closing, quiet',
    ],
    moodWords: ['honest', 'aching', 'quiet', 'true'],
    defaultEnvironment: {
      type: 'lived-in interior',
      weather: 'gentle natural',
      keyFeatures: ['warm lamps', 'family photos', 'worn furniture', 'soft textiles'],
      colorPalette: ['muted earth', 'warm amber'],
      timeOfDay: 'evening',
    },
    forbiddenStyleTerms: ['high fantasy', 'cyberpunk', 'horror'],
  },
  comedy: {
    artDirection:
      'painterly anime comedy, bouncy linework, expressive squash-and-stretch faces, bright friendly palette',
    lightingPalette: 'bright cheerful natural light, warm key, soft fill',
    colorPalette: ['warm yellows', 'sky blue', 'pastel pinks', 'leaf green'],
    textureDepth: 'painterly with playful pattern and bounce',
    shadowStyle: 'soft',
    cameraVocabulary: [
      'snappy whip pan reactions',
      'tight reaction close-up',
      'wide gag composition',
      'ground-level chase',
      'fast push-in punchline',
    ],
    motionVocabulary:
      'expressive timing, double-take reactions, bouncing motion, exaggerated gestures',
    atmosphericEffects: [
      'kawaii sparkles',
      'comic burst lines on impact',
      'puff of dust on landing',
      'falling petals or confetti',
    ],
    transitionStyle: 'bouncy whip pan or iris in/out',
    musicMoods: [
      'bouncy ukulele',
      'playful pizzicato',
      'jazz comedy walking bass',
      'silly woodwind solo',
      'cheerful resolution',
    ],
    soundDesign: [
      'comedy boings, footfalls',
      'rustles, bird chirps',
      'glass tinkle, laughter',
      'whoosh, impact',
      'soft sigh, applause',
    ],
    moodWords: ['playful', 'warm', 'goofy', 'easy'],
    defaultEnvironment: {
      type: 'cozy interior or bright exterior',
      weather: 'sunny',
      keyFeatures: ['cluttered desks', 'open windows', 'sunflowers', 'street markets'],
      colorPalette: ['warm yellow', 'sky blue', 'pastel pink'],
      timeOfDay: 'mid-morning',
    },
    forbiddenStyleTerms: ['horror', 'gore', 'cyberpunk dystopia'],
  },
  action: {
    artDirection:
      'painterly anime action, dynamic linework, motion blur, bold contrast, decisive composition',
    lightingPalette: 'high-contrast key, rim light separation, fire glow, kicked dust haze',
    colorPalette: ['scorched orange', 'deep blue', 'metallic silver', 'crimson accent'],
    textureDepth: 'painterly with kinetic linework and impact effects',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'low-angle hero shot',
      'whip pan on impact',
      'tracking sprint',
      'aerial action sweep',
      'slow-mo punch-in',
    ],
    motionVocabulary:
      'explosive movement, controlled combat, debris flying, hair and cloth whipping',
    atmosphericEffects: [
      'sparks and embers',
      'kicked dust clouds',
      'shock-wave distortion',
      'falling debris',
    ],
    transitionStyle: 'hard cut on impact or motion match-cut',
    musicMoods: [
      'driving percussion',
      'epic orchestral hits',
      'electric guitar riff',
      'tense breakdown',
      'heroic theme',
    ],
    soundDesign: [
      'metal clash, foot impacts',
      'breath, fabric tear',
      'glass shatter, debris',
      'fire roar, distant alarms',
      'wind, settling dust',
    ],
    moodWords: ['decisive', 'kinetic', 'unstoppable', 'pressure'],
    defaultEnvironment: {
      type: 'dynamic action arena',
      weather: 'dramatic',
      keyFeatures: ['ruined columns', 'rain or sparks', 'urban rooftops', 'industrial catwalks'],
      colorPalette: ['scorched orange', 'deep blue', 'silver'],
      timeOfDay: 'late afternoon storm light',
    },
    forbiddenStyleTerms: ['kawaii', 'cottagecore', 'pastel romance'],
  },
  emotional: {
    artDirection:
      'painterly anime emotional, intimate framing, warm color storytelling, expressive faces with tears or quiet smiles',
    lightingPalette: 'warm window light, candlelight, soft golden hour, low-key tender',
    colorPalette: ['warm amber', 'rose pink', 'creamy white', 'twilight blue'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: [
      'slow push-in on face',
      'rack focus between subjects',
      'close-up on hands',
      'wide pull-back to loneliness',
      'over-the-shoulder tender frame',
    ],
    motionVocabulary:
      'subtle breath, tear sliding, hand reaching, head lowering, soft embrace',
    atmosphericEffects: [
      'soft floating petals or snow',
      'rain on window',
      'firelight flicker',
      'curtains stirring',
    ],
    transitionStyle: 'tender soft dissolve held longer than usual',
    musicMoods: [
      'solo piano',
      'string ensemble swell',
      'female vocalise',
      'cello solo',
      'breath of silence',
    ],
    soundDesign: [
      'breath, fabric',
      'rain on window',
      'distant music box',
      'fire crackle',
      'silence with heartbeat',
    ],
    moodWords: ['tender', 'aching', 'gentle release', 'quiet truth'],
    defaultEnvironment: {
      type: 'warm intimate interior',
      weather: 'gentle natural',
      keyFeatures: ['warm window light', 'family photos', 'soft textiles', 'flowering branches'],
      colorPalette: ['warm amber', 'rose pink', 'creamy white'],
      timeOfDay: 'golden hour',
    },
    forbiddenStyleTerms: ['horror', 'cyberpunk', 'gore'],
  },
  mythology: {
    artDirection:
      'painterly anime myth, monumental scale, fresco-like compositions, divine light, ancient symbolism',
    lightingPalette: 'godrays, divine rim light, golden religious glow, dawn over horizon',
    colorPalette: ['gold', 'ivory', 'deep crimson', 'celestial blue'],
    textureDepth: 'painterly with stone and gold-leaf texture',
    shadowStyle: 'dramatic',
    cameraVocabulary: [
      'low-angle monumental shot',
      'wide ceremonial frame',
      'slow rise from kneeling',
      'orbit around relic',
      'silhouette against horizon',
    ],
    motionVocabulary:
      'measured ceremonial motion, robes flowing, stone shifting, divine apparitions forming',
    atmosphericEffects: [
      'falling petals or ash',
      'embers rising',
      'gold dust in beams',
      'water rippling around statues',
    ],
    transitionStyle: 'slow dissolve through light',
    musicMoods: [
      'choral voices',
      'taiko or temple drums',
      'ancient flute and koto',
      'orchestral swell with chant',
      'reverent solo voice',
    ],
    soundDesign: [
      'wind across stone, distant bell',
      'ceremonial drum, breath',
      'water in basin, footsteps',
      'thunder of stone, voices',
      'fading chant, silence',
    ],
    moodWords: ['reverent', 'inevitable', 'monumental', 'sacred'],
    defaultEnvironment: {
      type: 'temple, mountain, or divine plane',
      weather: 'dramatic celestial',
      keyFeatures: ['stone columns', 'sacred basin', 'distant horizon', 'carved symbols'],
      colorPalette: ['gold', 'ivory', 'crimson'],
      timeOfDay: 'dawn or twilight',
    },
    forbiddenStyleTerms: ['cyberpunk', 'kawaii', 'modern urban'],
  },
  historical: {
    artDirection:
      'painterly anime period piece, era-accurate clothing and architecture, restrained palette, lived-in detail',
    lightingPalette: 'natural era light - candle, oil lamp, daylight through small windows',
    colorPalette: ['muted earth', 'period dyes', 'aged paper', 'iron blacks'],
    textureDepth: 'painterly with period-accurate fabric weave and woodgrain',
    shadowStyle: 'soft',
    cameraVocabulary: [
      'static observational frame',
      'slow dolly through period setting',
      'over-the-shoulder of period activity',
      'wide vista of era landscape',
      'close-up on hands at work',
    ],
    motionVocabulary:
      'period-accurate motion, hand-tools at work, riding, weaving, careful gestures',
    atmosphericEffects: [
      'smoke from hearth',
      'dust in shafts of light',
      'falling leaves of season',
      'breath in cold air',
    ],
    transitionStyle: 'soft dissolve through period detail',
    musicMoods: [
      'era-appropriate strings',
      'folk instruments',
      'choral voices',
      'wind instruments',
      'simple acoustic theme',
    ],
    soundDesign: [
      'crackling hearth, footsteps on stone',
      'horse hooves, leather creak',
      'metal on anvil, breath',
      'distant bells, voices',
      'wind across fields',
    ],
    moodWords: ['weighted', 'lived-in', 'careful', 'inheritance'],
    defaultEnvironment: {
      type: 'period interior or rural exterior',
      weather: 'seasonal',
      keyFeatures: ['hearth', 'period fabrics', 'wooden tools', 'stone walls'],
      colorPalette: ['muted earth', 'period dye'],
      timeOfDay: 'late afternoon',
    },
    forbiddenStyleTerms: ['cyberpunk', 'modern tech', 'neon'],
  },
  'slice-of-life': {
    artDirection:
      'painterly anime slice-of-life, warm everyday detail, gentle palette, lived-in textures, expressive faces',
    lightingPalette: 'warm daylight through windows, soft afternoon, evening lamps',
    colorPalette: ['warm cream', 'soft sky blue', 'wood brown', 'pastel green'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: [
      'static observational frame',
      'slow dolly across the room',
      'wide cozy two-shot',
      'close-up on hands',
      'window-light reverse',
    ],
    motionVocabulary:
      'small honest motions, stirring tea, turning pages, walking home, friends laughing softly',
    atmosphericEffects: [
      'steam from a cup',
      'dust in afternoon light',
      'curtains stirring',
      'cherry petals or snow drifting',
    ],
    transitionStyle: 'soft seasonal dissolve',
    musicMoods: [
      'gentle ukulele',
      'piano and cello',
      'soft vocals',
      'jazzy walking bass',
      'breath of silence',
    ],
    soundDesign: [
      'kettle, footsteps',
      'distant chatter, rustle',
      'soft bells, paper',
      'rain on window',
      'silence with breath',
    ],
    moodWords: ['warm', 'unhurried', 'gentle', 'present'],
    defaultEnvironment: {
      type: 'cozy interior or seasonal town',
      weather: 'mild seasonal',
      keyFeatures: ['warm lamps', 'tea sets', 'open windows', 'paper doors'],
      colorPalette: ['warm cream', 'sky blue', 'wood brown'],
      timeOfDay: 'late afternoon',
    },
    forbiddenStyleTerms: ['horror', 'cyberpunk', 'gore'],
  },
  'dark-fantasy': {
    artDirection:
      'painterly anime dark fantasy, brooding palette, gothic detail, ominous architecture, moonlit atmosphere',
    lightingPalette: 'cold moonlight, candle pools, distant fires, blue-black shadows',
    colorPalette: ['midnight blue', 'iron gray', 'crimson accent', 'bone white'],
    textureDepth: 'painterly with stone and tattered fabric texture',
    shadowStyle: 'dramatic',
    cameraVocabulary: [
      'low-angle dread shot',
      'slow push through ruins',
      'wide silhouette against moon',
      'close-up on weathered relic',
      'long take through corridor',
    ],
    motionVocabulary:
      'cloaked figures moving, stone settling, embers rising, breath in cold air',
    atmosphericEffects: [
      'rolling fog',
      'dying embers',
      'moths in moonlight',
      'snow or ash falling slow',
    ],
    transitionStyle: 'slow dissolve into shadow',
    musicMoods: [
      'choral dread',
      'low strings with distant horn',
      'broken music box',
      'tense pulse',
      'mournful theme',
    ],
    soundDesign: [
      'wind through ruins, distant howl',
      'cloak rustle, breath',
      'stone shifting, embers',
      'silence then drum hit',
      'fading wind',
    ],
    moodWords: ['ominous', 'cursed', 'mournful', 'fated'],
    defaultEnvironment: {
      type: 'gothic ruin or cursed wilderness',
      weather: 'storm or fog',
      keyFeatures: ['shattered statues', 'crumbling towers', 'thorned briars', 'old graveyards'],
      colorPalette: ['midnight blue', 'iron gray', 'crimson'],
      timeOfDay: 'moonlit night',
    },
    forbiddenStyleTerms: ['kawaii', 'pastel', 'comedy'],
  },
  psychological: {
    artDirection:
      'painterly anime psychological, restrained palette, fractured framing, mirrors and reflections, subtle distortion',
    lightingPalette: 'cold practical light, single-source key, flickering bulbs, surreal color shifts',
    colorPalette: ['cold blue', 'sickly green', 'sterile white', 'shadow black'],
    textureDepth: 'painterly with fractured glass and double-exposure feel',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'slow dolly into reflection',
      'dutch tilt unease',
      'rack focus between selves',
      'extreme close-up on eye',
      'long-take static frame',
    ],
    motionVocabulary:
      'mirrored motion, repeating gestures, slowed perception, subtle wrong details',
    atmosphericEffects: [
      'flickering light',
      'shifting wallpaper pattern',
      'distorted reflection',
      'rain that falls upward',
    ],
    transitionStyle: 'morph or mirror-flip transition',
    musicMoods: [
      'detuned piano',
      'tense sustained drone',
      'reversed strings',
      'rising dissonance',
      'solitary motif',
    ],
    soundDesign: [
      'breath, ringing tone',
      'distant voice, paper',
      'static pulse',
      'silence then heartbeat',
      'fading hum',
    ],
    moodWords: ['unmoored', 'doubting', 'fractured', 'inescapable'],
    defaultEnvironment: {
      type: 'sterile interior or distorted memory space',
      weather: 'unclear',
      keyFeatures: ['mirrors', 'long corridors', 'flickering lights', 'shifting walls'],
      colorPalette: ['cold blue', 'sickly green', 'sterile white'],
      timeOfDay: 'unspecified / surreal',
    },
    forbiddenStyleTerms: ['kawaii', 'pastel romance', 'cottagecore'],
  },
  inspirational: {
    artDirection:
      'painterly anime inspirational, expansive vistas, warm horizon, hopeful framing, expressive triumph',
    lightingPalette: 'sunrise light, golden horizon, warm rim, hopeful sky',
    colorPalette: ['sunrise gold', 'sky blue', 'cream', 'warm green'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'soft',
    cameraVocabulary: [
      'low-angle hero shot against sky',
      'slow rise from struggle',
      'wide vista of distance traveled',
      'over-the-shoulder forward motion',
      'crane up to horizon',
    ],
    motionVocabulary:
      'rising posture, deep breath, decisive step forward, wind catching cloak',
    atmosphericEffects: [
      'sun-drenched dust',
      'wind across grass',
      'lifting clouds',
      'distant flock of birds',
    ],
    transitionStyle: 'soft dissolve into wider vista',
    musicMoods: [
      'rising piano theme',
      'orchestral swell with strings',
      'hopeful brass',
      'choral lift',
      'warm acoustic resolution',
    ],
    soundDesign: [
      'wind across fields, distant calls',
      'footsteps gaining pace',
      'breath, heart beat',
      'rising music, distant cheers',
      'wind, silence of accomplishment',
    ],
    moodWords: ['hopeful', 'rising', 'earned', 'expansive'],
    defaultEnvironment: {
      type: 'open landscape or community space',
      weather: 'clear with rolling clouds',
      keyFeatures: ['horizon', 'rolling hills', 'community spaces', 'open paths'],
      colorPalette: ['sunrise gold', 'sky blue', 'cream'],
      timeOfDay: 'sunrise',
    },
    forbiddenStyleTerms: ['horror', 'cyberpunk dystopia', 'gore'],
  },
  kids: {
    artDirection:
      'painterly anime for children, friendly round shapes, bright cheerful palette, big expressive eyes, safe atmosphere',
    lightingPalette: 'bright cheerful daylight, warm key, soft fill, no harsh shadows',
    colorPalette: ['primary brights', 'pastel pinks', 'sky blue', 'leaf green'],
    textureDepth: 'painterly soft, almost picture-book',
    shadowStyle: 'soft',
    cameraVocabulary: [
      'eye-level character shot',
      'slow push-in on smile',
      'wide cheerful establishing',
      'low-angle play shot',
      'gentle pan across friends',
    ],
    motionVocabulary:
      'bouncy friendly motion, expressive reactions, hopping, waving, hugging',
    atmosphericEffects: [
      'sparkle of wonder',
      'falling petals',
      'rainbow light',
      'bubbles or stars',
    ],
    transitionStyle: 'cheerful iris or soft wipe',
    musicMoods: [
      'playful ukulele',
      'bright xylophone',
      'happy whistle',
      'gentle warm theme',
      'cheerful resolution',
    ],
    soundDesign: [
      'birds, laughter',
      'soft toy bell, footsteps',
      'wind in leaves, voices',
      'soft chime, breath',
      'gentle music, hush',
    ],
    moodWords: ['safe', 'curious', 'warm', 'silly'],
    defaultEnvironment: {
      type: 'friendly cozy world',
      weather: 'bright sunny',
      keyFeatures: ['toy details', 'flowers', 'friendly creatures', 'small homes'],
      colorPalette: ['primary brights', 'pastel pinks', 'sky blue'],
      timeOfDay: 'mid-morning',
    },
    forbiddenStyleTerms: ['horror', 'gore', 'sexualized', 'cyberpunk dystopia'],
  },
  survival: {
    artDirection:
      'painterly anime survival, raw natural detail, weathered textures, resourceful framing, harsh beauty',
    lightingPalette: 'natural harsh sun, fire glow at night, low-angle storm light',
    colorPalette: ['weathered earth', 'storm gray', 'fire orange', 'cold blue'],
    textureDepth: 'painterly with weathered, abraded textures',
    shadowStyle: 'hard',
    cameraVocabulary: [
      'low-angle endurance shot',
      'wide hostile vista',
      'close-up on hands at work',
      'tracking through brush',
      'high-angle exhaustion frame',
    ],
    motionVocabulary:
      'careful conserved motion, tying knots, stoking fires, scanning the horizon',
    atmosphericEffects: [
      'wind-driven snow or sand',
      'ember sparks',
      'breath in cold air',
      'rolling storm clouds',
    ],
    transitionStyle: 'hard cut on resource decision',
    musicMoods: [
      'sparse percussion',
      'low strings',
      'lonely flute',
      'rising tension build',
      'hard-won theme',
    ],
    soundDesign: [
      'wind, footfalls on grit',
      'fire crackle, breath',
      'animal calls in distance',
      'rain or snow, fabric',
      'silence of vast space',
    ],
    moodWords: ['endurance', 'raw', 'careful', 'unyielding'],
    defaultEnvironment: {
      type: 'hostile wilderness',
      weather: 'harsh',
      keyFeatures: ['rocky terrain', 'sparse shelter', 'icy or arid landscape', 'fire pit'],
      colorPalette: ['weathered earth', 'storm gray', 'fire orange'],
      timeOfDay: 'storm-light',
    },
    forbiddenStyleTerms: ['kawaii', 'cottagecore comfort'],
  },
  'anime-style': {
    artDirection:
      'classic painterly anime, vibrant cel-shaded characters, expressive eyes, dynamic compositions',
    lightingPalette: 'bright cinematic key, warm fill, dramatic backlight where useful',
    colorPalette: ['saturated cel-anime palette', 'sky blue', 'sunset gold', 'cherry pink'],
    textureDepth: 'painterly cel-shaded with crisp linework',
    shadowStyle: 'soft',
    cameraVocabulary: [
      'classic anime push-in',
      'speed-line tracking',
      'low-angle hero reveal',
      'character close-up with sparkle',
      'wide establishing with parallax',
    ],
    motionVocabulary:
      'dynamic anime motion, expressive reactions, hair flowing, decisive movement',
    atmosphericEffects: [
      'cherry petals',
      'speed lines on motion',
      'sparkle effects',
      'wind currents',
    ],
    transitionStyle: 'classic anime fade or speed-line wipe',
    musicMoods: [
      'anime opening theme energy',
      'emotional piano',
      'hype rock',
      'tender ballad',
      'cinematic build',
    ],
    soundDesign: [
      'wind, distant chatter',
      'footsteps, breath',
      'magical chime, impact',
      'silence then swell',
      'gentle bells',
    ],
    moodWords: ['vivid', 'expressive', 'iconic', 'emotional'],
    defaultEnvironment: {
      type: 'classic anime world',
      weather: 'cinematic',
      keyFeatures: ['cherry trees', 'school rooftops', 'dramatic skies', 'iconic locations'],
      colorPalette: ['saturated cel-anime palette'],
      timeOfDay: 'sunset',
    },
    forbiddenStyleTerms: ['photorealistic', 'horror gore'],
  },
  'viral-trend': {
    artDirection:
      'painterly anime tuned for short-form virality, bold opening frame, high-contrast hook composition, shareable mood',
    lightingPalette: 'high-contrast key, bold rim, social-media-friendly color pop',
    colorPalette: ['bold accent', 'high-contrast palette', 'eye-catching gradient'],
    textureDepth: GHIBLI_BASELINE.textureDepth,
    shadowStyle: 'hard',
    cameraVocabulary: [
      'snap-zoom hook',
      'whip pan reveal',
      'tight reaction close-up',
      'bold low-angle hero shot',
      'fast tracking sprint',
    ],
    motionVocabulary:
      'punchy quick movement, reaction beats timed for retention',
    atmosphericEffects: [
      'bold particle effects',
      'lens flares',
      'kinetic motion lines',
      'shareable visual hooks',
    ],
    transitionStyle: 'hard cut on beat / whip pan',
    musicMoods: [
      'trending hook',
      'punchy beat drop',
      'tense build',
      'climactic swell',
      'satisfying outro tag',
    ],
    soundDesign: [
      'social-media-friendly stings',
      'whoosh, impact',
      'breath, heartbeat',
      'silence then hit',
      'tag sound',
    ],
    moodWords: ['punchy', 'shareable', 'bold', 'hook-first'],
    defaultEnvironment: {
      type: 'visually striking attention-grabbing setting',
      weather: 'dramatic',
      keyFeatures: ['high-contrast environment', 'bold composition', 'iconic landmark feel'],
      colorPalette: ['bold accent', 'high-contrast'],
      timeOfDay: 'cinematic',
    },
    forbiddenStyleTerms: ['boring', 'flat composition'],
  },
};

export function getStylePack(genre: string): StylePack {
  const key = genre.toLowerCase() as Genre;
  return STYLE_PACKS[key] || STYLE_PACKS.fantasy;
}
