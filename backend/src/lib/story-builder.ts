/**
 * Story builder
 *
 * Builds a full Story object from generated episode meta + scene narrations.
 * Genre-aware end-to-end: characters, environment, prompts, music, and
 * sound design all respect the genre style pack.
 */

import { randomUUID } from 'node:crypto';
import type { CharacterBible } from '../services/character-bible.js';
import type { WorldBible } from '../services/world-bible.js';
import { safeJsonParse } from './sanitize.js';
import { getStylePack } from './style-packs.js';
import { buildScenePrompts } from './prompt-engine.js';
import { episodeToVoiceoverScript } from './subtitle-export.js';
import { buildVoiceoverText } from './tts-normalize.js';
import {
  durationFromWords,
  timingFor,
  EPISODES_PER_STORY,
} from './timing.js';
import { pickGenreFallback } from './episode-generator.js';
import type {
  Story,
  StoryMetadata,
  Episode,
  Scene,
  Character,
  Environment,
  Genre,
} from '../services/types.js';

export interface BuildStoryInput {
  title: string;
  genre: string;
  seed?: string;
  theme: string;
  protagonistName: string;
  protagonistAge?: string;
  // M31: Protagonist gender. The character built from this input gets
  // the matching `gender` field so the row persisted by
  // buildStoryCreateData carries it. The character-bible's gender
  // takes precedence if both are set (bible is the AI-resolved value).
  protagonistGender?: 'male' | 'female' | 'neutral';
  episodes: Array<{
    title: string;
    hook: string;
    synopsis: string;
    scenes: string[];
    cliffhanger: string;
    episodeSummary: string;
  }>;
  characterBible?: CharacterBible;
  worldBible?: WorldBible;
}

export function buildStoryFromEpisodes(input: BuildStoryInput): Story {
  const {
    title,
    genre,
    seed,
    theme,
    protagonistName,
    protagonistGender,
    episodes,
    characterBible,
    worldBible,
  } = input;

  const storyId = randomUUID();
  const pack = getStylePack(genre);

  // ---------- Protagonist ----------
  const protagonistAppearance =
    characterBible?.facialFeatures && characterBible?.clothing
      ? `${characterBible.facialFeatures}. ${characterBible.clothing}`
      : `Expressive eyes, soft features, clothing appropriate to ${genre} setting, painterly anime aesthetic`;

  const protagonistPersonality = characterBible?.speechPatterns
    ? characterBible.speechPatterns
    : `Authentic to the ${genre} register; ${pack.moodWords[0] || 'engaged'}`;

  const protagonist: Character = {
    id: randomUUID(),
    name: protagonistName,
    description: `Protagonist of a ${genre} story`,
    appearance: protagonistAppearance,
    personality: protagonistPersonality,
    role: 'protagonist',
    arc: theme,
    emotions: characterBible?.emotions || [],
    catchphrases: characterBible?.catchphrases || [],
    ...(characterBible?.speechPatterns ? { speechPatterns: characterBible.speechPatterns } : {}),
    ...(characterBible?.clothing ? { clothing: characterBible.clothing } : {}),
    ...(characterBible?.facialFeatures ? { facialFeatures: characterBible.facialFeatures } : {}),
    ...(characterBible?.physicalMannerisms ? { physicalMannerisms: characterBible.physicalMannerisms } : {}),
    // M31: Carry the character-bible's resolved gender onto the
    // persisted character row. The bible value (set by the AI in Stage
    // 3) takes precedence; the caller's protagonistGender is used as
    // a fallback when the bible omitted the field.
    gender: characterBible?.gender ?? protagonistGender ?? 'neutral',
  };

  // ---------- Antagonist + supporting (from world bible if provided) ----------
  const antagonist: Character = worldBible
    ? { id: randomUUID(), ...worldBible.antagonist }
    : {
        id: randomUUID(),
        name: 'The Adversary',
        description: 'A force that opposes the protagonist',
        appearance: 'genre-appropriate antagonistic presence',
        personality: 'driven, in opposition',
        role: 'antagonist',
      };

  const supporting: Character = worldBible
    ? { id: randomUUID(), ...worldBible.supporting }
    : {
        id: randomUUID(),
        name: 'The Ally',
        description: 'A trusted companion or guide',
        appearance: 'genre-appropriate supporting presence',
        personality: 'loyal, complementary',
        role: 'supporting',
      };

  const characters: Character[] = [
    protagonist,
    {
      ...antagonist,
      // Persist character-bible-style fields too, even for ant/sup, so the UI
      // can render them consistently.
    },
    supporting,
  ];

  // ---------- Environments (L4-ENV-MULTI) ----------
  // Prefer the array; fall back to the singular `environment` for
  // backward compat with persisted world-bible blobs that predate the
  // multi-environment change. Always emit at least one Environment so
  // scenes can reference it.
  const buildEnvironmentFromWb = (wbEnv: Omit<Environment, 'id'>): Environment => ({
    id: randomUUID(),
    name:
      wbEnv.name ||
      pack.defaultEnvironment.type
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') || 'Genre Setting',
    description: wbEnv.description || `A ${pack.defaultEnvironment.type} fitting the ${genre} mood`,
    type: wbEnv.type || pack.defaultEnvironment.type,
    timeOfDay: wbEnv.timeOfDay || pack.defaultEnvironment.timeOfDay,
    weather: wbEnv.weather || pack.defaultEnvironment.weather,
    mood: wbEnv.mood || pack.moodWords[0] || 'cinematic',
    keyFeatures: wbEnv.keyFeatures ?? pack.defaultEnvironment.keyFeatures,
    colorPalette: wbEnv.colorPalette ?? pack.defaultEnvironment.colorPalette,
    lighting: {
      primary: wbEnv.lighting?.primary ?? pack.lightingPalette,
      ambient: wbEnv.lighting?.ambient ?? 'soft fill matched to genre',
      colorTemperature: wbEnv.lighting?.colorTemperature ?? pack.colorPalette[0] ?? 'neutral',
      shadows: wbEnv.lighting?.shadows ?? pack.shadowStyle,
    },
  });

  const environments: Environment[] = worldBible
    ? (worldBible.environments && worldBible.environments.length > 0
        ? worldBible.environments.map(buildEnvironmentFromWb)
        : [buildEnvironmentFromWb(worldBible.environment)])
    : [buildEnvironmentFromWb({
        name: '',
        description: '',
        type: pack.defaultEnvironment.type,
        timeOfDay: pack.defaultEnvironment.timeOfDay,
        weather: pack.defaultEnvironment.weather,
        mood: pack.moodWords[0] || 'cinematic',
        keyFeatures: pack.defaultEnvironment.keyFeatures,
        colorPalette: pack.defaultEnvironment.colorPalette,
        lighting: {
          primary: pack.lightingPalette,
          ambient: 'soft fill matched to genre',
          colorTemperature: pack.colorPalette[0] || 'neutral',
          shadows: pack.shadowStyle,
        },
      })];

  // ---------- Episodes ----------
  const storyEpisodes: Episode[] = episodes.map((ep, index) => {
    const episodeNumber = index + 1;
    const episodeId = randomUUID();

    const scenes: Scene[] = ep.scenes.map((rawNarration, sceneIndex) => {
      const cleaned = cleanNarration(rawNarration, sceneIndex, {
        genre,
        protagonistName,
        gender: protagonistGender ?? 'neutral',
        episodeIndex: index,
      });
      const duration = calculateDuration(cleaned);

      const prompts = buildScenePrompts({
        genre,
        episodeNumber,
        sceneIndex,
        narrationText: cleaned,
        protagonist,
        antagonist,
        supporting,
        // L4-ENV-MULTI: scene prompts reference the primary environment.
        // The world-bible now returns an array; the first entry is the
        // primary setting, which is what scene-prompt generation needs.
        environment: environments[0]!,
        ...(characterBible !== undefined ? { characterBible } : {}),
        previousNarration: sceneIndex > 0 ? cleanNarration(ep.scenes[sceneIndex - 1]!, sceneIndex - 1) : null,
      });

      const sceneId = randomUUID();
      return {
        id: sceneId,
        number: sceneIndex + 1,
        duration,
        narration: {
          id: sceneId,
          text: cleaned,
          timing: timingFor(duration),
          emotion: prompts.emotion,
        },
        imagePrompt: {
          id: sceneId,
          type: 'image',
          content: prompts.imagePrompt,
          version: 1,
          createdAt: new Date().toISOString(),
        },
        videoPrompt: {
          id: sceneId,
          type: 'video',
          content: prompts.videoPrompt,
          version: 1,
          createdAt: new Date().toISOString(),
        },
        cameraDirection: prompts.cameraDirection,
        emotionalIntensity: prompts.emotionalIntensity,
        transitionType: prompts.transitionType,
        characterState: prompts.characterState,
        environmentState: prompts.environmentState,
      };
    });

    const builtEpisode: Episode = {
      id: episodeId,
      number: episodeNumber,
      title: ep.title || `Episode ${episodeNumber}`,
      synopsis: ep.synopsis,
      hook: ep.hook,
      cliffhanger: ep.cliffhanger,
      duration: scenes.reduce((sum, s) => sum + s.duration, 0),
      scenes,
      voiceoverScript: '',
      voiceoverText: '',
      musicSuggestions: musicFor(genre, episodeNumber),
      soundDesign: soundFor(genre, episodeNumber),
    };

    builtEpisode.voiceoverScript = episodeToVoiceoverScript(builtEpisode);
    builtEpisode.voiceoverText = buildVoiceoverText({
      hook: ep.hook,
      scenes: scenes.map((s) => s.narration.text),
      cliffhanger: ep.cliffhanger,
    });
    return builtEpisode;
  });

  // ---------- Metadata ----------
  const totalScenes = storyEpisodes.reduce((sum, ep) => sum + ep.scenes.length, 0);
  const totalDuration = storyEpisodes.reduce((sum, ep) => sum + ep.duration, 0);

  return {
    id: storyId,
    title,
    genre: genre as Genre,
    ...(seed !== undefined ? { seed } : {}),
    theme,
    status: 'complete',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    episodes: storyEpisodes,
    characters,
    // L4-ENV-MULTI: pass all environments the world bible generated, so
    // the DB row count matches the number of distinct locations the
    // story actually references.
    environments,
    metadata: {
      totalEpisodes: episodes.length || EPISODES_PER_STORY,
      totalScenes,
      estimatedDuration: totalDuration,
      targetAudience: `YouTube Shorts viewers who love ${genre} stories with cinematic painterly anime aesthetics`,
      // Stage 8 quality evaluation populates the actual score fields before
      // persistence; no placeholder values are written here (L18).
    } as StoryMetadata,
    embedding: null,
  };
}

// ---------- Cleaning ----------

// REL-018: Strict prefix list. The previous `else if (text.includes(':'))`
// stripped everything before the first colon, which caught any text that
// happened to contain a colon — including the canned-mode defaultResponse
// ("Canned response: test mode is active..."), causing scene 1 of episode 1
// to lose its full narration. Real narration prose is allowed to contain
// colons; only AI-output label prefixes should be stripped.
const NARRATION_LABEL_PREFIXES: RegExp[] = [
  /^\s*Scene\s+\d+\s*[:.]\s*/i,
  /^\s*Episode\s+\d+\s*[:.]\s*/i,
  /^\s*EpisodeNumber\s*[:.]\s*['"]?\d+['"]?\s*[:.]\s*/i,
  /^\s*Narration\s*[:.]\s*/i,
  /^\s*Voiceover\s*[:.]\s*/i,
  /^\s*VO\s*[:.]\s*/i,
];

function stripNarrationLabelPrefix(text: string): string {
  for (const re of NARRATION_LABEL_PREFIXES) {
    if (re.test(text)) return text.replace(re, '');
  }
  return text;
}

export function cleanNarration(
  narrationText: string,
  sceneIndex: number,
  fallbackCtx?: { genre: string; protagonistName: string; gender: 'male' | 'female' | 'neutral'; episodeIndex: number }
): string {
  let clean = narrationText;

  if (narrationText.startsWith('{') && narrationText.includes('"hook"')) {
    try {
      const parsed = safeJsonParse<Partial<{ hook: string; scenes: string[] }>>(narrationText);
      clean = parsed.hook || parsed.scenes?.[sceneIndex] || narrationText;
    } catch {
      const m = narrationText.match(/"hook"\s*:\s*"([^"]+)"/);
      if (m) clean = m[1]!;
    }
  } else {
    // REL-018: only strip known label prefixes; preserve prose that contains colons.
    clean = stripNarrationLabelPrefix(narrationText);
  }

  if (clean.split(/\s+/).length < 5) {
    // M11: use the genre/gender-aware fallback when context is available —
    // the previous fixed placeholder produced IDENTICAL narration for every
    // short scene within and across episodes (and reached the TTS voiceover).
    if (fallbackCtx) {
      clean = pickGenreFallback(fallbackCtx.genre, sceneIndex + 1, fallbackCtx.protagonistName, '', fallbackCtx.gender, fallbackCtx.episodeIndex);
    } else {
      clean =
        'The protagonist faces a crucial moment as the journey continues. The path forward narrows; something important is about to be decided.';
    }
  }
  return clean;
}

function calculateDuration(text: string): number {
  // Use the centralized timing math (~145 WPM, +1 s breath buffer, clamped to 10-12 s — see timing.ts SCENE_DURATION_MIN/MAX_SECONDS).
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return durationFromWords(words);
}

// ---------- Music + sound (genre-aware) ----------

function musicFor(genre: string, episodeNumber: number): string[] {
  const pack = getStylePack(genre);
  return [pack.musicMoods[(episodeNumber - 1) % pack.musicMoods.length]!];
}

function soundFor(genre: string, episodeNumber: number): string[] {
  const pack = getStylePack(genre);
  return [pack.soundDesign[(episodeNumber - 1) % pack.soundDesign.length]!];
}
