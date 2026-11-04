interface JsonRecord { [key: string]: string }
export function asJsonRecord(json: unknown): JsonRecord {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (v !== null && v !== undefined)
        out[k] = String(v);
    }
    return out;
  }
  return {};
}

interface DbScene { id: string; number: number; duration: number; version?: number; narrationText?: string | null; narrationEmotion?: string | null; narrationTiming?: unknown; characterState?: unknown; environmentState?: unknown; cameraMovement?: string | null; cameraAngle?: string | null; cameraLens?: string | null; cameraType?: string | null; imagePromptContent?: string | null; imagePromptVersion?: number | null; imagePromptCreatedAt?: Date | null; videoPromptContent?: string | null; videoPromptVersion?: number | null; videoPromptCreatedAt?: Date | null; emotionalIntensity?: number | null; transitionType?: string | null; updatedAt?: Date; }

function convertScene(scene: DbScene) {
  const timing = scene.narrationTiming || null;
  const charState = scene.characterState;
  const envState = scene.environmentState;
  return {
    id: scene.id,
    number: scene.number,
    duration: scene.duration,
    narration: {
      id: scene.id,
      text: scene.narrationText || '',
      emotion: (scene.narrationEmotion || 'neutral') as import('../../services/types.js').Emotion,
      timing: (() => {
        const t = timing as { totalDuration?: unknown; wordsPerMinute?: unknown; charactersPerMinute?: unknown } | null;
        return t && typeof t === 'object'
          ? {
            totalDuration: Number(t.totalDuration ?? 15),
            wordsPerMinute: Number(t.wordsPerMinute ?? 150),
            charactersPerMinute: Number(t.charactersPerMinute ?? 900),
          }
          : { totalDuration: 15, wordsPerMinute: 150, charactersPerMinute: 900 };
      })(),
    },
    imagePrompt: {
      id: scene.id,
      type: 'image' as const,
      content: scene.imagePromptContent || '',
      version: scene.imagePromptVersion ?? 1,
      ...(scene.imagePromptCreatedAt
        ? { createdAt: new Date(scene.imagePromptCreatedAt).toISOString() }
        : {}),
    },
    videoPrompt: {
      id: scene.id,
      type: 'video' as const,
      content: scene.videoPromptContent || '',
      version: scene.videoPromptVersion ?? 1,
      ...(scene.videoPromptCreatedAt
        ? { createdAt: new Date(scene.videoPromptCreatedAt).toISOString() }
        : {}),
    },
    cameraDirection: {
      type: (scene.cameraType || 'static') as import('../../services/types.js').CameraDirection['type'],
      movement: scene.cameraMovement || '',
      angle: scene.cameraAngle || '',
      lens: scene.cameraLens || '',
    },
    emotionalIntensity: scene.emotionalIntensity ?? 5,
    transitionType: (scene.transitionType || 'cut') as import('../../services/types.js').TransitionType,
    ...(scene.version != null ? { version: scene.version } : {}),
    characterState: (charState && typeof charState === 'object' && !Array.isArray(charState)
      ? charState
      : {
        characterId: '',
        position: 'center frame',
        action: 'standing',
        emotion: 'neutral',
        expression: 'calm',
        bodyLanguage: 'natural',
      }) as import('../../services/types.js').CharacterState,
    environmentState: (envState && typeof envState === 'object' && !Array.isArray(envState)
      ? envState
      : {
        environmentId: '',
        timeOfDay: 'day',
        weather: 'clear',
        lighting: 'natural',
        atmosphere: 'calm',
        ambientSounds: [],
      }) as import('../../services/types.js').EnvironmentState,
  };
}

interface DbEpisode { id: string; number: number; title: string; synopsis: string; hook: string; cliffhanger: string; duration: number; version?: number; scenes?: DbScene[]; voiceoverScript?: string | null; voiceoverText?: string | null; musicSuggestions?: string[]; soundDesign?: string[]; }

function convertEpisode(episode: DbEpisode) {
  return {
    id: episode.id,
    number: episode.number,
    title: episode.title,
    synopsis: episode.synopsis,
    hook: episode.hook,
    cliffhanger: episode.cliffhanger,
    duration: episode.duration,
    ...(episode.version != null ? { version: episode.version } : {}),
    scenes: (episode.scenes || []).map(convertScene),
    ...(episode.voiceoverScript ? { voiceoverScript: episode.voiceoverScript } : {}),
    ...(episode.voiceoverText ? { voiceoverText: episode.voiceoverText } : {}),
    ...(episode.musicSuggestions?.length ? { musicSuggestions: episode.musicSuggestions } : {}),
    ...(episode.soundDesign?.length ? { soundDesign: episode.soundDesign } : {}),
  };
}

interface DbCharacter { id: string; name: string; description: string; appearance: string; personality: string; role: string; speechPatterns?: string | null; clothing?: string | null; facialFeatures?: string | null; emotions?: string[]; relationships?: unknown; catchphrases?: string[]; physicalMannerisms?: string | null; gender?: string | null; }

function convertCharacter(char: DbCharacter) {
  return {
    id: char.id,
    name: char.name,
    description: char.description,
    appearance: char.appearance,
    personality: char.personality,
    role: char.role as import('../../services/types.js').Character['role'],
    ...(char.speechPatterns != null ? { speechPatterns: char.speechPatterns } : {}),
    ...(char.clothing != null ? { clothing: char.clothing } : {}),
    ...(char.facialFeatures != null ? { facialFeatures: char.facialFeatures } : {}),
    ...(char.emotions?.length ? { emotions: char.emotions } : {}),
    ...(char.relationships ? { relationships: asJsonRecord(char.relationships) } : {}),
    ...(char.catchphrases?.length ? { catchphrases: char.catchphrases } : {}),
    ...(char.physicalMannerisms != null ? { physicalMannerisms: char.physicalMannerisms } : {}),
    gender: (char.gender ?? 'neutral') as 'male' | 'female' | 'neutral',
  };
}

interface DbEnvironment { id: string; name: string; description: string; type: string; timeOfDay: string; weather: string; mood: string; keyFeatures?: string[]; colorPalette?: string[]; lightingSetup?: unknown; }

function convertEnvironment(env: DbEnvironment) {
  const lighting = env.lightingSetup;
  const lightingObj = (() => {
    const l = lighting as { primary?: unknown; ambient?: unknown; colorTemperature?: unknown; shadows?: unknown; secondary?: unknown } | null;
    return (l && typeof l === 'object' && !Array.isArray(l)) ? l : {};
  })();
  return {
    id: env.id,
    name: env.name,
    description: env.description,
    type: env.type,
    timeOfDay: env.timeOfDay,
    weather: env.weather,
    mood: env.mood,
    keyFeatures: env.keyFeatures ?? [],
    colorPalette: env.colorPalette ?? [],
    lighting: {
      primary: String(lightingObj.primary ?? ''),
      ambient: String(lightingObj.ambient ?? ''),
      colorTemperature: String(lightingObj.colorTemperature ?? ''),
      shadows: (lightingObj.shadows || 'soft') as import('../../services/types.js').LightingSetup['shadows'],
      ...(lightingObj.secondary ? { secondary: String(lightingObj.secondary) } : {}),
    },
  };
}

export interface DbStoryFull { id: string; title: string; genre: string; seed?: string | null; theme?: string | null; seedStoryId?: string | null; userId?: string | null; status: string; createdAt: Date; updatedAt: Date; episodes?: DbEpisode[]; characters?: DbCharacter[]; environments?: DbEnvironment[]; embedding?: number[]; targetAudience?: string | null; qualityScore?: number | null; qualityGrade?: string | null; humanizationScore?: number | null; monetizationScore?: number | null; viralityScore?: number | null; retentionScore?: number | null; hookStrength?: number | null; qualityRecommendations?: string[]; qualityIssues?: string[]; algorithmTips?: string[]; alternateTitles?: string[]; youtubeSeo?: unknown; episodeCount?: number | null; sceneCount?: number | null; }

export function convertStory(story: DbStoryFull): import('../../services/types.js').Story {
  const episodes = (story.episodes || [])
    .slice()
    .sort((a, b) => a.number - b.number)
    .map(convertEpisode);
  const youtubeSeo = story.youtubeSeo as { title?: string; description?: string; tags?: string[]; thumbnailSuggestions?: string[]; videoTemplate?: string; hookScript?: string; algorithmBoostTips?: string[]; viralPotential?: number; recommendedDuration?: string; targetAudience?: string; trendingKeywords?: string[]; ctaScript?: string; } | undefined;
  return {
    id: story.id,
    title: story.title,
    genre: story.genre as import('../../services/types.js').Genre,
    status: story.status as import('../../services/types.js').StoryStatus,
    createdAt: story.createdAt.toISOString(),
    updatedAt: story.updatedAt.toISOString(),
    episodes,
    characters: (story.characters || []).map(convertCharacter),
    environments: (story.environments || []).map(convertEnvironment),
    ...(story.seed ? { seed: story.seed } : {}),
    ...(story.theme ? { theme: story.theme } : {}),
    ...(story.seedStoryId ? { seedStoryId: story.seedStoryId } : {}),
    ...(story.userId ? { userId: story.userId } : {}),
    ...(story.episodeCount != null ? { episodeCount: story.episodeCount } : {}),
    ...(story.sceneCount != null ? { sceneCount: story.sceneCount } : {}),
    ...(story.qualityScore != null ? { qualityScore: story.qualityScore } : {}),
    ...(story.qualityGrade != null ? { qualityGrade: story.qualityGrade as 'A' | 'B' | 'C' | 'D' | 'F' } : {}),
    ...(Array.isArray(story.embedding) && story.embedding.length > 0 ? { embedding: story.embedding } : {}),
    metadata: {
      totalEpisodes: episodes.length > 0 ? episodes.length : (story.episodeCount ?? 0),
      totalScenes: episodes.length > 0
        ? episodes.reduce((sum, ep) => sum + ep.scenes.length, 0)
        : (story.sceneCount ?? 0),
      estimatedDuration: episodes.reduce((sum, ep) => sum + ep.duration, 0),
      targetAudience: story.targetAudience || 'general',
      ...(story.monetizationScore != null ? { monetizationScore: story.monetizationScore } : {}),
      ...(story.viralityScore != null ? { viralityScore: story.viralityScore } : {}),
      ...(story.retentionScore != null ? { retentionScore: story.retentionScore } : {}),
      ...(story.hookStrength != null ? { hookStrength: story.hookStrength } : {}),
      ...(story.qualityScore != null ? { qualityScore: story.qualityScore } : {}),
      ...(story.qualityGrade != null ? { qualityGrade: story.qualityGrade as 'A' | 'B' | 'C' | 'D' | 'F' } : {}),
      ...(story.humanizationScore != null ? { humanizationScore: story.humanizationScore } : {}),
      ...(story.qualityRecommendations?.length ? { qualityRecommendations: story.qualityRecommendations } : {}),
      ...(story.qualityIssues?.length ? { qualityIssues: story.qualityIssues } : {}),
      ...(story.algorithmTips?.length ? { algorithmTips: story.algorithmTips } : {}),
      ...(story.alternateTitles?.length ? { alternateTitles: story.alternateTitles } : {}),
    },
    ...(youtubeSeo
      ? {
        youtubeSeo: {
          title: youtubeSeo.title || '',
          description: youtubeSeo.description || '',
          tags: youtubeSeo.tags || [],
          thumbnailSuggestions: youtubeSeo.thumbnailSuggestions || [],
          videoTemplate: youtubeSeo.videoTemplate || '',
          hookScript: youtubeSeo.hookScript || '',
          algorithmBoostTips: youtubeSeo.algorithmBoostTips || [],
          viralPotential: youtubeSeo.viralPotential ?? 75,
          recommendedDuration: youtubeSeo.recommendedDuration || '',
          targetAudience: youtubeSeo.targetAudience || '',
          trendingKeywords: youtubeSeo.trendingKeywords || [],
          ctaScript: youtubeSeo.ctaScript || '',
        },
      }
      : {}),
  };
}
