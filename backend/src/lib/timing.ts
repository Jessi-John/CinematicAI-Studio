/**
 * Single source of truth for narration timing.
 *
 * The whole pipeline targets ~50 seconds of spoken narration per episode at
 * a cinematic delivery rate. All other modules MUST import these constants
 * rather than redefining their own to avoid drift between worker, builder,
 * exporter, and DB conversion.
 *
 * BIZ-002: These constants have database overrides in SystemSettings. The
 * worker loads DB values at pipeline start and passes them through
 * StageContext so stages don't do redundant DB lookups. The code-level
 * constants here serve as fallback defaults when SystemSettings is unreachable.
 *
 * LIVE BINDINGS: The `export let` values below are ES module live bindings.
 * When `loadTimingOverrides()` reassigns them, every importer sees the new
 * value. Do NOT change `export let` to `export const` — that would break
 * the live-binding semantics that `loadTimingOverrides()` relies on.
 * New code should use the accessor functions (getEpisodesPerStory(), etc.)
 * which are the canonical way to read the current value.
 */

import { getSystemSettingInt } from '../services/settings.js';

// ---------- Code defaults (fallback when DB is unreachable) ----------

export const SPEAKING_WPM = 145;
export const SPEAKING_CPM = 870; // approx for English narration
export const TARGET_EPISODE_SECONDS = 50;

// 145 WPM × 50 s ÷ 60 s/min ≈ 121 words.
// 145 WPM × 60 s ÷ 60 s/min ≈ 145 words.
// The word-count band maps directly to 50-60s at 145 WPM speaking rate.
// Each scene gets a +1s breath buffer in durationFromWords, so the raw
// word count sits slightly below the duration target to compensate.
export const TARGET_EPISODE_WORDS = Math.round(
  (SPEAKING_WPM * TARGET_EPISODE_SECONDS) / 60
);
export const TARGET_WORDS_PER_EPISODE_MIN = 121;
export const TARGET_WORDS_PER_EPISODE_MAX = 145;

// 5 scenes per episode → ~24-29 words per scene sweet spot, 10-12 s per scene.
// The scene duration clamp (10-12s) guarantees that 5 scenes always land
// between 50-60s total regardless of per-scene variation.
export const SCENES_PER_EPISODE = 5;
export const EPISODES_PER_STORY = 10;
export const TARGET_WORDS_PER_SCENE = Math.round(TARGET_EPISODE_WORDS / SCENES_PER_EPISODE);
export const SCENE_DURATION_MIN_SECONDS = 10;
export const SCENE_DURATION_MAX_SECONDS = 12;

// Mutable runtime values — live ES module bindings updated by loadTimingOverrides().
// Existing importers see the updated value due to live-binding semantics.
// New code should use the accessor functions below.
export let episodesPerStory = EPISODES_PER_STORY;
export let scenesPerEpisode = SCENES_PER_EPISODE;
export let targetWordsPerScene = TARGET_WORDS_PER_SCENE;
export let targetEpisodeWordsMin = TARGET_WORDS_PER_EPISODE_MIN;
export let targetEpisodeWordsMax = TARGET_WORDS_PER_EPISODE_MAX;
export let sceneDurationMinSeconds = SCENE_DURATION_MIN_SECONDS;
export let sceneDurationMaxSeconds = SCENE_DURATION_MAX_SECONDS;
export let speakingWpm = SPEAKING_WPM;
export let targetEpisodeSeconds = TARGET_EPISODE_SECONDS;

/**
 * Load timing overrides from SystemSettings. Called by runStoryPipeline
 * at startup so all stages use consistent values without repeated DB queries.
 * Falls back to code defaults if DB is unreachable.
 *
 * Updates the live ES module bindings (export let values above).
 * All importers automatically see the new values due to live-binding semantics.
 */
export async function loadTimingOverrides(): Promise<void> {
  [episodesPerStory, scenesPerEpisode, targetWordsPerScene, targetEpisodeWordsMin,
    targetEpisodeWordsMax, sceneDurationMinSeconds, sceneDurationMaxSeconds,
    speakingWpm, targetEpisodeSeconds] = await Promise.all([
    getSystemSettingInt('episodes_per_story', EPISODES_PER_STORY),
    getSystemSettingInt('scenes_per_episode', SCENES_PER_EPISODE),
    getSystemSettingInt('target_words_per_scene', TARGET_WORDS_PER_SCENE),
    getSystemSettingInt('target_words_per_episode_min', TARGET_WORDS_PER_EPISODE_MIN),
    getSystemSettingInt('target_words_per_episode_max', TARGET_WORDS_PER_EPISODE_MAX),
    getSystemSettingInt('scene_duration_min_seconds', SCENE_DURATION_MIN_SECONDS),
    getSystemSettingInt('scene_duration_max_seconds', SCENE_DURATION_MAX_SECONDS),
    getSystemSettingInt('speaking_wpm', SPEAKING_WPM),
    getSystemSettingInt('target_episode_seconds', TARGET_EPISODE_SECONDS),
  ]);
}

// ---------- Canonical accessor functions ----------
// These are the recommended way to read the current timing values.
// They return the live binding values (updated by loadTimingOverrides()).
// Importing the export-let variables directly works too, but the accessor
// functions are the canonical API that will not change if the internal
// variable names are refactored.

export function getEpisodesPerStory(): number { return episodesPerStory; }
export function getScenesPerEpisode(): number { return scenesPerEpisode; }
export function getTargetWordsPerScene(): number { return targetWordsPerScene; }
export function getTargetEpisodeWordsMin(): number { return targetEpisodeWordsMin; }
export function getTargetEpisodeWordsMax(): number { return targetEpisodeWordsMax; }
export function getSceneDurationMinSeconds(): number { return sceneDurationMinSeconds; }
export function getSceneDurationMaxSeconds(): number { return sceneDurationMaxSeconds; }
export function getSpeakingWpm(): number { return speakingWpm; }
export function getTargetEpisodeSeconds(): number { return targetEpisodeSeconds; }

/**
 * Convert a narration word count to spoken seconds, clamped to the
 * per-scene band. The +1 second buffer accounts for breath and pacing.
 */
export function durationFromWords(words: number): number {
  const wps = speakingWpm / 60; // words per second
  const seconds = Math.round(words / wps) + 1;
  return Math.min(
    Math.max(seconds, sceneDurationMinSeconds),
    sceneDurationMaxSeconds
  );
}

/**
 * Build a VoiceoverTiming record for a clip of `seconds` length.
 */
export function timingFor(seconds: number): {
  totalDuration: number;
  wordsPerMinute: number;
  charactersPerMinute: number;
} {
  return {
    totalDuration: seconds,
    wordsPerMinute: speakingWpm,
    charactersPerMinute: SPEAKING_CPM,
  };
}
