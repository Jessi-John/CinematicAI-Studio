import { validateStoryInvariants, validateEmbedding } from './validation.js';

export interface StoryInput {
  id: string; title: string; genre: string; seed?: string | null; theme?: string | null; status: string;
  userId: string;
  /**
   * M32: Optional deduplication key. When omitted, defaults to seed so the
   * (genre, deduplicationKey) partial unique index behaves like the previous
   * (genre, seed) index. forceNew=true sets this to a unique value to allow
   * intentional duplicate seeds.
   */
  deduplicationKey?: string;
  episodes: Array<{
    id: string; number: number; title: string; synopsis: string; hook: string; cliffhanger: string; duration: number;
    voiceoverScript?: string | null; voiceoverText?: string | null; musicSuggestions?: string[]; soundDesign?: string[];
    scenes: Array<{
      id: string; number: number; duration: number;
      narration: { text: string; emotion: string; timing: unknown };
      imagePrompt: { content: string; version: number; createdAt?: string };
      videoPrompt: { content: string; version: number; createdAt?: string };
      cameraDirection: { type: string; movement: string; angle: string; lens: string };
      characterState: unknown; environmentState: unknown;
      emotionalIntensity?: number; transitionType?: string;
    }>;
  }>;
  characters: Array<{
    id: string; name: string; description: string; appearance: string; personality: string; role: string;
    speechPatterns?: string; clothing?: string; facialFeatures?: string; emotions?: string[];
    relationships?: unknown; catchphrases?: string[]; physicalMannerisms?: string;
    gender?: 'male' | 'female' | 'neutral';
  }>;
  environments: Array<{
    id: string; name: string; description: string; type: string; timeOfDay: string;
    weather: string; mood: string; keyFeatures: string[]; colorPalette: string[];
    lighting: { primary: string; ambient: string; colorTemperature: string; shadows?: string; secondary?: string };
  }>;
  embedding?: number[];
  metadata?: {
    targetAudience?: string; qualityScore?: number; qualityGrade?: string; humanizationScore?: number;
    qualityRecommendations?: string[]; qualityIssues?: string[]; algorithmTips?: string[]; alternateTitles?: string[];
    monetizationScore?: number; viralityScore?: number; retentionScore?: number; hookStrength?: number;
  };
  youtubeSeo?: {
    title: string; description: string; tags: string[]; thumbnailSuggestions: string[];
    videoTemplate?: string; hookScript?: string; algorithmBoostTips?: string[];
    viralPotential?: number; recommendedDuration?: string; targetAudience?: string;
    trendingKeywords?: string[]; ctaScript?: string;
  } | null;
}

export function isStoryInput(value: unknown): value is StoryInput {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<StoryInput>;
  return typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    typeof s.genre === 'string' &&
    typeof s.status === 'string' &&
    typeof s.userId === 'string' &&
    Array.isArray(s.episodes) &&
    Array.isArray(s.characters) &&
    Array.isArray(s.environments);
}

// L6: `any` retained because Prisma's nested create input types (Story → Episode → Scene)
// are deeply recursive and do not compose cleanly into a single return type. The shape
// is validated at runtime by `validateStoryInvariants` and at the Prisma call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildStoryCreateData(story: StoryInput): any {
  validateStoryInvariants(story);
  const safeEmbedding = validateEmbedding(story.embedding);

  return {
    id: story.id,
    title: story.title,
    genre: story.genre,
    seed: story.seed || null,
    // M32: Use an explicit deduplicationKey when provided (forceNew), otherwise
    // fall back to seed so the partial unique index blocks accidental duplicates.
    // L7: `story.seed ?? null` would store '' as the dedup key for empty-string
    // seeds while `seed` stores NULL — two such stories would collide on
    // (genre, ''). Use the same `|| null` normalization on both paths.
    deduplicationKey: story.deduplicationKey ?? (story.seed || null),
    theme: story.theme || null,
    status: story.status,
    user: { connect: { id: story.userId } },
    targetAudience: story.metadata?.targetAudience || null,
    embedding: safeEmbedding,
    qualityScore: story.metadata?.qualityScore ?? null,
    qualityGrade: story.metadata?.qualityGrade ?? null,
    humanizationScore: story.metadata?.humanizationScore ?? null,
    monetizationScore: story.metadata?.monetizationScore ?? null,
    viralityScore: story.metadata?.viralityScore ?? null,
    retentionScore: story.metadata?.retentionScore ?? null,
    hookStrength: story.metadata?.hookStrength ?? null,
    qualityRecommendations: (story.metadata?.qualityRecommendations ?? []),
    qualityIssues: (story.metadata?.qualityIssues ?? []),
    algorithmTips: (story.metadata?.algorithmTips ?? []),
    alternateTitles: (story.metadata?.alternateTitles ?? []),
    episodeCount: story.episodes.length,
    sceneCount: story.episodes.reduce((sum, ep) => sum + ep.scenes.length, 0),
    characters: {
      create: story.characters.map((char) => ({
        id: char.id,
        name: char.name,
        description: char.description,
        appearance: char.appearance,
        personality: char.personality,
        role: char.role as import('../../services/types.js').Character['role'],
        speechPatterns: char.speechPatterns || null,
        clothing: char.clothing || null,
        facialFeatures: char.facialFeatures || null,
        emotions: char.emotions || [],
        relationships: (char.relationships ?? {}),
        catchphrases: char.catchphrases || [],
        physicalMannerisms: char.physicalMannerisms || null,
        gender: char.gender ?? 'neutral',
      })),
    },
    environments: {
      create: story.environments.map((env) => ({
        id: env.id,
        name: env.name,
        description: env.description,
        type: env.type,
        timeOfDay: env.timeOfDay,
        weather: env.weather,
        mood: env.mood,
        keyFeatures: env.keyFeatures,
        colorPalette: env.colorPalette,
        lightingSetup: env.lighting,
      })),
    },
    episodes: {
      create: story.episodes.map((ep) => ({
        id: ep.id,
        number: ep.number,
        title: ep.title,
        synopsis: ep.synopsis,
        hook: ep.hook,
        cliffhanger: ep.cliffhanger,
        duration: ep.duration,
        voiceoverScript: ep.voiceoverScript || null,
        voiceoverText: ep.voiceoverText || null,
        musicSuggestions: ep.musicSuggestions || [],
        soundDesign: ep.soundDesign || [],
        scenes: {
          create: ep.scenes.map((sc) => ({
            id: sc.id,
            number: sc.number,
            duration: sc.duration,
            narrationText: sc.narration.text,
            narrationEmotion: sc.narration.emotion,
            narrationTiming: sc.narration.timing,
            voiceoverNotes: null,
            imagePromptContent: sc.imagePrompt.content,
            imagePromptVersion: sc.imagePrompt.version,
            imagePromptCreatedAt: sc.imagePrompt.createdAt ? new Date(sc.imagePrompt.createdAt) : undefined,
            imageModel: null,
            videoPromptContent: sc.videoPrompt.content,
            videoPromptVersion: sc.videoPrompt.version,
            videoPromptCreatedAt: sc.videoPrompt.createdAt ? new Date(sc.videoPrompt.createdAt) : undefined,
            videoModel: null,
            cameraType: sc.cameraDirection.type,
            cameraMovement: sc.cameraDirection.movement,
            cameraAngle: sc.cameraDirection.angle,
            cameraLens: sc.cameraDirection.lens,
            emotionalIntensity: sc.emotionalIntensity,
            transitionType: sc.transitionType,
            characterState: sc.characterState,
            environmentState: sc.environmentState,
            visualNotes: null,
            audioNotes: null,
            // M1: maintain the denormalized story id (trigger + queries rely on it)
            storyId: story.id,
          })),
        },
      })),
    },
    // M4: Only create a YouTubeSEO row when the story actually has SEO data —
    // previously every story got a junk row with empty strings, making "no SEO
    // generated" indistinguishable from "SEO generated but empty".
    ...(story.youtubeSeo
      ? {
          youtubeSeo: {
            create: {
              title: story.youtubeSeo.title || '',
              description: story.youtubeSeo.description || '',
              tags: story.youtubeSeo.tags || [],
              thumbnailSuggestions: story.youtubeSeo.thumbnailSuggestions || [],
              videoTemplate: story.youtubeSeo.videoTemplate || '',
              hookScript: story.youtubeSeo.hookScript || '',
              algorithmBoostTips: story.youtubeSeo.algorithmBoostTips || [],
              viralPotential: story.youtubeSeo.viralPotential ?? 75,
              recommendedDuration: story.youtubeSeo.recommendedDuration || '',
              targetAudience: story.youtubeSeo.targetAudience || '',
              trendingKeywords: story.youtubeSeo.trendingKeywords || [],
              ctaScript: story.youtubeSeo.ctaScript || '',
            },
          },
        }
      : {}),
  };
}
