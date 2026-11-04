/**
 * Phase 2 / Fix #21: shared types for the per-stage pipeline.
 *
 * Each stage function is a pure-ish `(ctx, helpers) => Promise<void>` unit
 * that mutates `ctx` and (optionally) calls helpers to checkpoint progress.
 * The orchestrator (`runGenerationCore` in `story.worker.ts`) sequences
 * the stages and owns the only mutable per-process state (Redis checkpoint
 * keys, candidate JSON).
 *
 * Splitting types out of the worker lets each stage file be a small,
 * focused module — easier to read, easier to unit-test in isolation, and
 * easier to add new stages without scrolling past 1500 lines of mixed
 * concerns.
 */

import type { Genre, Story } from '../../../services/types.js';
import type {
  GeneratedEpisode,
  StoryBlueprint,
} from '../../../lib/episode-generator.js';
import type { CharacterBible } from '../../../services/character-bible.js';
import type { WorldBible } from '../../../services/world-bible.js';
import type { getSharedRedis } from '../../../lib/shared-redis.js';

/** Per-job context that flows through every stage. Stages mutate this. */
export interface StageContext {
  primaryGenre: string;
  seed?: string;
  jobId: string;
  requestId: string;
  qualityFloor: number;
  gradeFloor: string;
  aiScoreLimit: number;
  storyBudget: number;
  persistMode: 'create' | 'return-candidate';
  /** H7: Watchdog abort signal propagated from the generation context so
   * stages can abort mid-loop instead of running an orphaned pipeline. */
  abortSignal?: AbortSignal;
  // M21: Per-job timing snapshot. Read once at the start of runStoryPipeline
  // and frozen for the job's lifetime. This prevents concurrent jobs from
  // racing on mutable module-level exports in timing.ts.
  episodesPerStory: number;
  scenesPerEpisode: number;
  targetWordsPerScene: number;
  targetEpisodeWordsMin: number;
  targetEpisodeWordsMax: number;
  sceneDurationMinSeconds: number;
  sceneDurationMaxSeconds: number;
  speakingWpm: number;
  targetEpisodeSeconds: number;
  // Mutable pipeline fields (set by stages as they complete)
  avoidanceConstraints?: string[];
  avoidCharacterNames?: string[];
  blueprint?: StoryBlueprint;
  characterBible?: CharacterBible;
  worldBible?: WorldBible;
  episodes?: GeneratedEpisode[];
  story?: Story;
  qualityScore?: number;
  qualityGrade?: string;
  qualityIssues?: string[];
  qualityRecommendations?: string[];
}

/** Per-call helpers owned by the orchestrator and passed to every stage. */
export interface StageHelpers {
  redis: ReturnType<typeof getSharedRedis>;
  progressEmit: (pct: number, stage: string, msg?: string, data?: unknown) => Promise<void>;
  isStageDone: (name: string) => Promise<boolean>;
  markStageDone: (name: string) => Promise<void>;
  loadCandidate: () => Promise<Story | null>;
  saveCandidate: (story: Story) => Promise<void>;
}

/** Inputs to the orchestrator. Built from the public RunGenerationOptions. */
export interface GenerationCoreContext {
  primaryGenre: string;
  seed?: string;
  jobId: string;
  requestId: string;
  progressEmit: (pct: number, stage: string, msg?: string, data?: unknown) => Promise<void>;
  qualityFloor: number;
  gradeFloor: string;
  aiScoreLimit: number;
  storyBudget: number;
  persistMode: 'create' | 'return-candidate';
  userId?: string;
  /** H7: BullMQ attempt number (attemptsMade). When > 0, all checkpoint keys
   * (candidate + stage:*:done flags) are namespaced with `:attempt:N:` so a
   * BullMQ retry never reads checkpoints written by an orphaned previous
   * attempt that is still running after the pipeline watchdog fired. */
  attempt?: number;
  /** M32: When true, the story is persisted with a unique deduplicationKey so
   * an intentional duplicate seed can bypass the (genre, deduplicationKey)
   * partial unique index. */
  forceNew?: boolean;
  /** H4: AbortSignal from the pipeline-level watchdog. When the pipeline
   * times out, this signal aborts so the orphaned runGenerationCore can
   * check it between stages and stop making AI calls instead of running
   * indefinitely. */
  abortSignal?: AbortSignal;
  /** REGEN-FAST: When set, the orchestrator pre-seeds the candidate JSON
   * and marks stages uniqueness / blueprint / character-bible / world-bible
   * as done BEFORE running the stage sequence. Each of those four stages
   * has an `isStageDone` early-return path that rehydrates `stageCtx` from
   * the candidate. As a result, regeneration can re-use the previous run's
   * blueprint, character bible, and world bible, and only re-roll episodes
   * (stage 5) and downstream stages 7-11. The Story value MUST contain the
   * canonical sidecar fields read by the pre-load block (protagonist,
   * environments); see buildPreloadedStoryCheckpoint in story-regeneration
   * for the exact shape. The orchestrator validates the shape and falls
   * back to running stages 1-4 normally if validation fails (e.g., a
   * preloaded story from before this field existed). */
  preloadedStory?: Story | null;
}

// Re-export for convenience so stage files can import a single namespace.
export type { Genre, Story };
