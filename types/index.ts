// ============================================
// Core Domain Types (shared with backend)
// ============================================

// Genre is derived from the GENRES const array in lib/constants/genres.ts
// to guarantee a single source of truth. Adding a new genre to GENRES
// automatically expands the type; modifying just one file is a compile error.
import type { Genre } from '@/lib/constants/genres';
export type { Genre };
/** @note API expects genre as array (string[]) for generation endpoint */
export type Genres = Genre[];

// L4-SHARED-TYPES: The canonical wire-shape of Story/Episode/Scene/etc.
// lives in backend/src/services/types.ts because the backend is the producer
// and its tsconfig rootDir prevents it from importing files outside src/.
// The frontend re-exports those types here so the rest of the UI imports
// from the same @/types path it always has, while the server page imports
// directly from @backend/services/types to avoid a duplicate contract.
import type {
  StoryStatus,
  TransitionType,
  Emotion,
  VoiceoverTiming,
  VoiceoverScript,
  Prompt,
  CameraDirection,
  CharacterState,
  EnvironmentState,
  Scene,
  Episode,
  Character,
  LightingSetup,
  Environment,
  YouTubeSEO,
  StoryMetadata,
  Story as BackendStory,
} from '@backend/services/types.js';

export type {
  StoryStatus,
  TransitionType,
  Emotion,
  VoiceoverTiming,
  VoiceoverScript,
  Prompt,
  CameraDirection,
  CharacterState,
  EnvironmentState,
  Scene,
  Episode,
  Character,
  LightingSetup,
  Environment,
  YouTubeSEO,
  StoryMetadata,
};

export type Story = BackendStory;

export type GenerationStage =
  | 'init'
  | 'uniqueness'
  | 'blueprint'
  | 'character_bible'
  | 'world_bible'
  | 'episodes'
  | 'building'
  | 'humanization'
  | 'quality'
  | 'seo'
  | 'embedding'
  | 'copyright'
  | 'persisting'
  | 'polling'
  | 'reconnecting'
  | 'retrying'
  | 'seed_evaluation'
  | 'seed_enriched'
  | 'budget'
  | 'complete';

export interface GenerationProgress {
  stage: GenerationStage;
  progress: number;
  message: string;
  currentStep?: string;
  totalSteps: number;
  completedSteps: number;
  estimatedTimeRemaining?: number;
}

// ============================================
// API Response Types
// ============================================
// Canonical discriminated union. Every API route returns either
// `{ success: true, data: T }` on success or `{ success: false, error: string }`
// on failure. This shape is shared between apiFetch in lib/utils/api.ts and
// every consuming hook/component. Defined here (not in lib/utils/api.ts) so
// types/index.ts remains the foundation layer with no dependency on utilities.

export interface ApiError {
  success: false;
  error: string;
  message?: string;
  // M3: HTTP status of the failed response, when known. Lets callers
  // distinguish a genuine auth failure (401/403) from a transient server
  // error (5xx) without re-deriving it from the error message.
  statusCode?: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

export type ApiResponse<T> = ApiError | ApiSuccess<T>;

export interface PaginatedStories {
  stories: Story[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

// ============================================
// UI / Export
// ============================================

export type ExportContent =
  | 'full'
  | 'prompts-only'
  | 'voiceover-only'
  | 'scenes-only';

export interface ExportData {
  filename: string;
  content: string;
  mimeType: string;
  size: number;
}
