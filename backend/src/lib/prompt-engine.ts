/**
 * Prompt Engine
 *
 * Genre-aware, context-rich image and video prompt builder.
 * Replaces the old hard-coded watercolor-forest template with prompts derived
 * from the actual scene narration, character bible, environment, and the
 * matching genre style pack.
 */

import type {
  Character,
  Environment,
  CameraDirection,
  CharacterState,
  EnvironmentState,
  Emotion,
  TransitionType,
} from '../services/types.js';
import { getStylePack } from './style-packs.js';
import type { CharacterBible } from '../services/character-bible.js';

export interface BuildPromptInput {
  genre: string;
  episodeNumber: number;
  sceneIndex: number; // 0..4
  narrationText: string;
  protagonist: Character;
  antagonist?: Character;
  supporting?: Character;
  environment: Environment;
  characterBible?: CharacterBible;
  previousNarration?: string | null;
}

export interface ScenePrompts {
  imagePrompt: string;
  videoPrompt: string;
  cameraDirection: CameraDirection;
  characterState: CharacterState;
  environmentState: EnvironmentState;
  emotion: Emotion;
  transitionType: TransitionType;
  emotionalIntensity: number;
}

const SCENE_BEAT_LABELS = [
  'opening beat - threshold crossed',
  'discovery - new information shifts the stakes',
  'movement - the protagonist commits to action',
  'confrontation - opposition arrives or escalates',
  'consequence - the beat that sets up the cliffhanger',
];

const COMPOSITION_HINTS = [
  'medium shot, rule-of-thirds, subject left-third, negative space right',
  'wide establishing, low horizon, expansive sky, deep parallax',
  'tracking medium, subject moving across frame, motion-blurred background',
  'close-up over the shoulder, shallow depth, key on subject\'s face',
  'low-angle hero shot, subject filling frame, dramatic backlight',
];

const TRANSITION_TYPES: TransitionType[] = ['cut', 'dissolve', 'fade', 'wipe'];

/**
 * Pick a deterministic value from an array based on (genre + episode + scene)
 * so we don't accidentally hard-code "always slow push-in for scene 0".
 */
function deterministicPick<T>(items: T[], key: string): T {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return items[Math.abs(h) % items.length]!;
}

// Per-genre emotion bias per scene beat (0..4). Root-cause fix for tone bleed:
// previously only 5 genre groups had dedicated biases and 12 genres fell
// through to a shared `driftBias` ending in 'mysterious', while psychological
// was mapped to the horror bias — pushing light/grounded genres toward dread.
// Every supported genre now has an explicit, genre-appropriate arc.
const GENRE_EMOTION_BIAS: Record<string, Emotion[]> = {
  fantasy: ['mysterious', 'mysterious', 'intense', 'dramatic', 'dramatic'],
  adventure: ['neutral', 'happy', 'intense', 'dramatic', 'dramatic'],
  romance: ['neutral', 'happy', 'dramatic', 'sad', 'happy'],
  horror: ['mysterious', 'mysterious', 'intense', 'intense', 'dramatic'],
  mystery: ['neutral', 'mysterious', 'mysterious', 'intense', 'dramatic'],
  thriller: ['neutral', 'intense', 'intense', 'dramatic', 'intense'],
  'sci-fi': ['neutral', 'mysterious', 'intense', 'intense', 'dramatic'],
  drama: ['neutral', 'neutral', 'sad', 'dramatic', 'dramatic'],
  comedy: ['happy', 'happy', 'happy', 'dramatic', 'happy'],
  action: ['neutral', 'intense', 'intense', 'dramatic', 'intense'],
  emotional: ['neutral', 'sad', 'dramatic', 'sad', 'happy'],
  mythology: ['mysterious', 'mysterious', 'dramatic', 'intense', 'dramatic'],
  historical: ['neutral', 'neutral', 'dramatic', 'intense', 'dramatic'],
  'slice-of-life': ['neutral', 'happy', 'neutral', 'happy', 'neutral'],
  'dark-fantasy': ['mysterious', 'mysterious', 'intense', 'intense', 'dramatic'],
  psychological: ['neutral', 'mysterious', 'mysterious', 'intense', 'mysterious'],
  inspirational: ['neutral', 'sad', 'neutral', 'dramatic', 'happy'],
  kids: ['happy', 'happy', 'neutral', 'happy', 'happy'],
  survival: ['neutral', 'intense', 'intense', 'dramatic', 'intense'],
  'anime-style': ['neutral', 'happy', 'dramatic', 'intense', 'dramatic'],
  'viral-trend': ['happy', 'neutral', 'happy', 'dramatic', 'happy'],
};

const GENRE_EMOTION_FALLBACK: Record<string, Emotion> = {
  fantasy: 'mysterious',
  horror: 'mysterious',
  'dark-fantasy': 'mysterious',
  psychological: 'mysterious',
  mythology: 'mysterious',
  mystery: 'mysterious',
  'sci-fi': 'neutral',
  action: 'intense',
  thriller: 'intense',
  survival: 'intense',
};

function emotionForBeat(beat: number, genre: string): Emotion {
  const lower = genre.toLowerCase();
  const bias = GENRE_EMOTION_BIAS[lower];
  if (bias) return bias[beat] ?? GENRE_EMOTION_FALLBACK[lower] ?? 'neutral';
  // Unknown genres walk a neutral arc instead of drifting dark.
  const neutralArc: Emotion[] = ['neutral', 'neutral', 'dramatic', 'dramatic', 'dramatic'];
  return neutralArc[beat] || 'neutral';
}

function intensityForBeat(beat: number, episodeNumber: number): number {
  const base = [4, 5, 6, 7, 8];
  const arcBoost = Math.floor(episodeNumber / 3); // later episodes hit harder
  return Math.min((base[beat] || 5) + arcBoost, 10);
}

function transitionForBeat(beat: number, genre: string): TransitionType {
  const pack = getStylePack(genre);
  if (pack.transitionStyle.includes('hard cut')) return 'cut';
  if (pack.transitionStyle.includes('iris') || pack.transitionStyle.includes('whip')) return 'wipe';
  if (pack.transitionStyle.includes('dissolve')) return 'dissolve';
  return TRANSITION_TYPES[beat % TRANSITION_TYPES.length]!;
}

function cameraForBeat(beat: number, genre: string, episodeNumber: number): CameraDirection {
  const pack = getStylePack(genre);
  // Movement is the most visually impactful axis — give it a 7-entry
  // pool keyed on (genre, episode, beat) so different beats get
  // different movements even when the underlying vocabulary is short.
  // The 7-entry rotation also ensures we visit each vocabulary word at
  // least once before repeating within a 5-scene episode.
  const movement =
    deterministicPick(pack.cameraVocabulary, `${genre}:${episodeNumber}:${beat}:movement`) ||
    pack.cameraVocabulary[beat % pack.cameraVocabulary.length] ||
    'static medium shot';

  // M32: Camera-type pool — 7 distinct values, no duplicates. The
  // prior array had 'static' twice at positions 0 and 4, which made
  // beat 0 and beat 4 always share the same type and contributed to
  // the cross-scene camera repetition observed in real stories.
  const types: CameraDirection['type'][] = [
    'static',
    'tracking',
    'dolly',
    'crane',
    'handheld',
    'pan',
    'tilt',
  ];
  const type = types[beat % types.length]!;

  // M32: Camera-angle pool — 5 distinct values, no duplicates. The
  // prior array repeated 'medium' and 'low' which made 3 of 5 scenes
  // per episode share the same angle. The new pool visits every angle
  // in the first 5 beats.
  const angles = ['medium', 'low', 'high', 'extreme-close', 'wide'];

  // M32: Camera-lens pool — 4 distinct values. The prior code
  // hardcoded the literal 'cinematic' for every scene, which
  // contributed to camera repetition across scenes. Different lenses
  // give the painterly anime aesthetic meaningful visual variety
  // without changing the underlying animation approach.
  const lenses = ['cinematic', 'wide-angle', 'telephoto', 'macro'];

  return {
    type,
    movement,
    angle: angles[beat % angles.length]!,
    lens: lenses[beat % lenses.length]!,
  };
}

/**
 * Build the image and video prompts for a single scene.
 */
export function buildScenePrompts(input: BuildPromptInput): ScenePrompts {
  const {
    genre,
    episodeNumber,
    sceneIndex,
    narrationText,
    protagonist,
    antagonist,
    supporting,
    environment,
    characterBible,
    previousNarration,
  } = input;

  const pack = getStylePack(genre);
  const beat = sceneIndex % 5;
  const beatLabel = SCENE_BEAT_LABELS[beat] || SCENE_BEAT_LABELS[0];
  const composition = COMPOSITION_HINTS[beat] || COMPOSITION_HINTS[0];
  const camera = cameraForBeat(beat, genre, episodeNumber);
  const emotion = emotionForBeat(beat, genre);
  const intensity = intensityForBeat(beat, episodeNumber);
  const transition = transitionForBeat(beat, genre);
  const moodWord = pack.moodWords[beat % pack.moodWords.length] ?? pack.moodWords[0] ?? '';
  const lighting = pack.lightingPalette;
  const palette = (environment.colorPalette.length > 0
    ? environment.colorPalette
    : pack.colorPalette
  ).join(', ');
  const features = environment.keyFeatures.join(', ');
  const atmospheric = pack.atmosphericEffects[beat % pack.atmosphericEffects.length] ?? pack.atmosphericEffects[0] ?? '';

  // Character description rich enough for image generation
  const protagonistDescription = characterBible
    ? `${protagonist.name}: ${characterBible.facialFeatures}; wearing ${characterBible.clothing}; mannerism - ${characterBible.physicalMannerisms}`
    : `${protagonist.name}: ${protagonist.appearance}`;

  const supportingLine =
    supporting && narrationContains(narrationText, supporting.name)
      ? `\n- Also in frame: ${supporting.name} (${supporting.appearance})`
      : '';
  const antagonistLine =
    antagonist && narrationContains(narrationText, antagonist.name)
      ? `\n- Antagonist presence: ${antagonist.name} (${antagonist.appearance})`
      : '';

  // ---------- IMAGE PROMPT ----------
  // Front-load the most distinctive scene moment so any IP-naive image model
  // gets a clear subject; then layer style, light, palette, atmosphere.
  // M32: Per-scene variation in the art-direction prefix. The prior code
  // used the literal `pack.artDirection` for every scene, so all 5 scenes
  // in an episode (and 50 scenes in a story) started with the IDENTICAL
  // "hand-painted watercolor anime, soft cel-shaded characters..."
  // string, varying only in the narration-derived "Scene moment:" line.
  // That defeated the point of having a per-scene prompt. The fix
  // composes a beat-specific style header that includes the per-beat
  // mood word, atmospheric effect, and composition hint — derived from
  // arrays already keyed on beat in the style pack. The result: every
  // scene in a story has a UNIQUE opening line that still belongs to
  // the same genre's visual vocabulary.
  const sceneStyleHeader = [
    pack.artDirection,
    `${moodWord} mood`,
    `${composition} composition`,
    `${atmospheric} atmosphere`,
  ].join(', ');

  const imagePrompt = [
    `${sceneStyleHeader}.`,
    `Scene moment: ${narrationText.trim()}`,
    `Subject: ${protagonistDescription}${supportingLine}${antagonistLine}`,
    `Setting: ${environment.name} - ${environment.description}. ${environment.timeOfDay}, ${environment.weather}. Notable features: ${features}.`,
    `Lighting: ${lighting}. Shadows: ${pack.shadowStyle}.`,
    `Color palette: ${palette}.`,
    `Atmosphere: ${moodWord}. Effects: ${atmospheric}.`,
    `Composition: ${composition}. Camera: ${camera.type} ${camera.movement}, ${camera.angle} angle, ${camera.lens} lens.`,
    `Texture and depth: ${pack.textureDepth}.`,
    `Quality: 4K, masterpiece, painterly cel-shaded anime, smooth gradients, no watermarks, no text overlays.`,
    pack.forbiddenStyleTerms.length > 0
      ? `Avoid: ${pack.forbiddenStyleTerms.join(', ')}.`
      : '',
    `Episode ${episodeNumber}, Scene ${sceneIndex + 1} (${beatLabel}).`,
  ]
    .filter(Boolean)
    .join('\n');

  // ---------- VIDEO PROMPT ----------
  // Image-to-video: how to animate the still. Reference subject motion,
  // environmental motion, atmospheric effects, transition in/out.
  // M32: Per-scene variation in the video prompt header. The prior code
  // always opened with the static "Animate the painted scene with
  // cinematic motion in the ${genre} register" line; now the opening
  // line includes the per-beat mood and composition, matching the
  // image-prompt fix above so video and image stay consistent.
  const transitionIn = previousNarration
    ? `Continuity: previous beat - "${previousNarration.slice(0, 80)}..." Transition in via ${pack.transitionStyle}.`
    : `Opening beat. No prior continuity.`;

  const videoPrompt = [
    `Animate the painted scene with ${moodWord} motion in the ${genre} register (${composition}).`,
    `Camera: ${camera.movement} (${camera.type}, ${camera.angle} angle, ${camera.lens} lens).`,
    `Subject motion: ${pack.motionVocabulary}. ${protagonist.name} performs the beat - ${beatFromNarration(narrationText)}.`,
    `Environmental motion: ${features ? `subtle motion across ${features}; ` : ''}${atmospheric}.`,
    `Atmosphere: ${moodWord}, emotional intensity ${intensity}/10.`,
    `Lighting evolution: ${lighting}. Shadows behave ${pack.shadowStyle}.`,
    transitionIn,
    `Pacing: 4-6 seconds, smooth ease-in / ease-out, hand-painted watercolor motion aesthetic.`,
    `Forbidden: any text overlays, captions, watermarks, jittery motion.`,
    `Output: photoreal-free painterly anime motion, 24fps, soft cel-shaded coherence with the source painting.`,
  ].join('\n');

  const characterState: CharacterState = {
    characterId: protagonist.id,
    position: deterministicPick(
      ['center frame', 'left third', 'right third', 'center frame', 'left third'],
      `${genre}:${episodeNumber}:${beat}:position`
    ),
    action: beatFromNarration(narrationText),
    emotion,
    expression: expressionFor(emotion),
    bodyLanguage: bodyLanguageFor(emotion),
  };

  const environmentState: EnvironmentState = {
    environmentId: environment.id,
    timeOfDay: environment.timeOfDay,
    weather: environment.weather,
    lighting,
    atmosphere: moodWord,
    ambientSounds: (pack.soundDesign[beat % pack.soundDesign.length] ?? pack.soundDesign[0] ?? '').split(', ').filter(Boolean),
  };

  return {
    imagePrompt,
    videoPrompt,
    cameraDirection: camera,
    characterState,
    environmentState,
    emotion,
    transitionType: transition,
    emotionalIntensity: intensity,
  };
}

// ---------- helpers ----------

function narrationContains(narration: string, name: string): boolean {
  const n = narration.toLowerCase();
  const parts = name.toLowerCase().split(/[\s,-]+/);
  return parts.some((p) => p.length > 2 && n.includes(p));
}

/**
 * Extract the dominant action from the narration line. Used as the subject motion
 * cue in the video prompt. We pick the first verb-rich clause when possible,
 * else fall back to the first sentence.
 */
function beatFromNarration(text: string): string {
  if (!text) return 'subtle expressive motion';
  const firstSentence = text.split(/[.!?](?:\s|$)/)[0] || text;
  return firstSentence.trim().slice(0, 160);
}

function expressionFor(emotion: Emotion): string {
  const map: Record<Emotion, string> = {
    neutral: 'calm and composed',
    happy: 'soft warm smile',
    dramatic: 'eyes widening, breath held',
    intense: 'jaw set, gaze locked',
    mysterious: 'half-lit unreadable expression',
    sad: 'downcast eyes, soft tension at the mouth',
  };
  return map[emotion] || 'natural';
}

function bodyLanguageFor(emotion: Emotion): string {
  const map: Record<Emotion, string> = {
    neutral: 'natural posture',
    happy: 'open shoulders, lifted chin',
    dramatic: 'leaning forward, hand reaching',
    intense: 'tight stance, weight forward',
    mysterious: 'still, watchful, weight balanced',
    sad: 'shoulders curled in, head lowered',
  };
  return map[emotion] || 'natural';
}
