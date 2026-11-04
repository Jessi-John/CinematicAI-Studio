// Core types - backend domain.

export type Genre =
  | 'fantasy'
  | 'adventure'
  | 'romance'
  | 'horror'
  | 'mystery'
  | 'thriller'
  | 'sci-fi'
  | 'drama'
  | 'comedy'
  | 'action'
  | 'emotional'
  | 'mythology'
  | 'historical'
  | 'slice-of-life'
  | 'dark-fantasy'
  | 'psychological'
  | 'inspirational'
  | 'kids'
  | 'survival'
  | 'anime-style'
  | 'viral-trend';

export type StoryStatus = 'draft' | 'generating' | 'complete' | 'failed';
export type TransitionType = 'cut' | 'dissolve' | 'fade' | 'wipe';
export type Emotion = 'neutral' | 'happy' | 'dramatic' | 'intense' | 'mysterious' | 'sad';

/**
 * Fix #28: Story status state machine.
 *
 * Valid transitions:
 *   draft      → generating  (worker starts generation)
 *   generating → complete    (worker succeeds)
 *   generating → failed      (worker fails after all retries exhausted)
 *   failed     → generating  (admin/manual retry)
 *   failed     → draft       (admin reset / discard)
 *
 * The API (PATCH /api/stories/:id) is only permitted to transition failed→draft.
 * All other transitions are controlled by the worker pipeline.
 * complete is a terminal state — no transitions out of it.
 */
export const STORY_STATUS_TRANSITIONS: Record<StoryStatus, readonly StoryStatus[]> = {
  draft:      ['generating'] as const,
  generating: ['complete', 'failed'] as const,
  complete:   [] as const,
  failed:     ['generating', 'draft'] as const,
} as const;

export function canTransitionStoryStatus(from: StoryStatus, to: StoryStatus): boolean {
  // L: return false (not TypeError) for an out-of-union `from` value.
  const allowed = STORY_STATUS_TRANSITIONS[from] as readonly StoryStatus[] | undefined;
  return allowed ? allowed.includes(to) : false;
}

export interface VoiceoverTiming {
  totalDuration: number;
  wordsPerMinute: number;
  charactersPerMinute: number;
}

export interface VoiceoverScript {
  id: string;
  text: string;
  timing: VoiceoverTiming;
  emotion: Emotion;
}

export interface Prompt {
  id: string;
  type: 'image' | 'video' | 'voiceover';
  content: string;
  version: number;
  createdAt?: string;
}

export interface CameraDirection {
  // M32: 'pan' and 'tilt' added so the per-beat camera-type pool in
  // prompt-engine.ts:cameraForBeat has 7 distinct values (was 5 with
  // 'static' repeated). The schema column is plain String so no DB
  // migration is needed for the new values.
  type: 'static' | 'tracking' | 'dolly' | 'crane' | 'handheld' | 'aerial' | 'pan' | 'tilt';
  movement: string;
  angle: string;
  lens: string;
}

export interface CharacterState {
  characterId: string;
  position: string;
  action: string;
  emotion: string;
  expression: string;
  bodyLanguage: string;
}

export interface EnvironmentState {
  environmentId: string;
  timeOfDay: string;
  weather: string;
  lighting: string;
  atmosphere: string;
  ambientSounds: string[];
}

export interface Scene {
  id: string;
  number: number;
  duration: number;
  narration: VoiceoverScript;
  imagePrompt: Prompt;
  videoPrompt: Prompt;
  cameraDirection: CameraDirection;
  emotionalIntensity: number;
  transitionType: TransitionType;
  characterState: CharacterState;
  environmentState: EnvironmentState;
  version?: number;
}

export interface Episode {
  id: string;
  number: number;
  title: string;
  synopsis: string;
  hook: string;
  cliffhanger: string;
  duration: number;
  scenes: Scene[];
  voiceoverScript?: string;
  voiceoverText?: string;
  musicSuggestions?: string[];
  soundDesign?: string[];
  version?: number;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  role: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
  arc?: string;
  speechPatterns?: string;
  clothing?: string;
  facialFeatures?: string;
  emotions?: string[];
  relationships?: Record<string, string>;
  catchphrases?: string[];
  physicalMannerisms?: string;
  // M31: Character gender. Populated by the character-bible AI (Stage 3)
  // and persisted by buildStoryCreateData. Drives pronoun consistency
  // in scene narration and is surfaced to the frontend for display.
  gender?: 'male' | 'female' | 'neutral';
}

export interface LightingSetup {
  primary: string;
  secondary?: string;
  ambient: string;
  colorTemperature: string;
  shadows: 'soft' | 'hard' | 'dramatic';
}

export interface Environment {
  id: string;
  name: string;
  description: string;
  type: string;
  timeOfDay: string;
  weather: string;
  mood: string;
  keyFeatures: string[];
  colorPalette: string[];
  lighting: LightingSetup;
}

export interface YouTubeSEO {
  title: string;
  description: string;
  tags: string[];
  thumbnailSuggestions: string[];
  videoTemplate: string;
  hookScript: string;
  algorithmBoostTips: string[];
  viralPotential: number;
  recommendedDuration: string;
  targetAudience: string;
  trendingKeywords: string[];
  ctaScript: string;
}

export interface StoryMetadata {
  totalEpisodes: number;
  totalScenes: number;
  estimatedDuration: number;
  targetAudience: string;
  monetizationScore?: number;
  viralityScore?: number;
  retentionScore?: number;
  hookStrength?: number;
  qualityScore?: number;
  qualityGrade?: 'A' | 'B' | 'C' | 'D' | 'F';
  humanizationScore?: number;
  qualityRecommendations?: string[];
  qualityIssues?: string[];
  algorithmTips?: string[];
  alternateTitles?: string[];
}

export interface Story {
  id: string;
  title: string;
  genre: Genre;
  seed?: string;
  theme?: string;
  seedStoryId?: string;
  userId?: string;
  status: StoryStatus;
  createdAt: string;
  updatedAt: string;
  episodes: Episode[];
  // M30: Cached counts populated at save time (see prisma-storage.ts).
  // Surface at root so list-view consumers can render episode/scene counts
  // without loading the full episodes+scenes tree.
  episodeCount?: number;
  sceneCount?: number;
  qualityScore?: number;
  qualityGrade?: 'A' | 'B' | 'C' | 'D' | 'F';
  characters: Character[];
  environments: Environment[];
  metadata: StoryMetadata;
  embedding?: number[] | null;
  youtubeSeo?: YouTubeSEO;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface UserSettingItem {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  updatedAt: string;
}


