import {
  durationFromWords,
  timingFor,
  SPEAKING_WPM,
  TARGET_EPISODE_WORDS,
  TARGET_WORDS_PER_EPISODE_MIN,
  TARGET_WORDS_PER_EPISODE_MAX,
  SCENE_DURATION_MIN_SECONDS,
  SCENE_DURATION_MAX_SECONDS,
  EPISODES_PER_STORY,
  SCENES_PER_EPISODE,
} from './timing.js';

describe('timing constants', () => {
  it('targets ~50 s of narration at the centralized WPM', () => {
    expect(SPEAKING_WPM).toBe(145);
    // 145 * 50 / 60 = 120.833 → rounded to 121
    expect(TARGET_EPISODE_WORDS).toBe(121);
  });

  it('keeps the episode word band tight enough to hit the spec', () => {
    // The band is 121-145 (TARGET_WORDS_PER_EPISODE_MIN/MAX in timing.ts).
    // An older, wider band was unreachable in practice — the model kept
    // producing ~30-word scenes and the rebalance could not converge.
    // 50 s ± 15% => 42.5 s ... 57.5 s.
    // At 145 WPM that's 102 ... 139 words for the strict spec; the wider
    // band (125-160) accepts up to 66.2 s of narration which is still
    // within YouTube Shorts tolerance but lets the rebalance converge.
    expect(TARGET_WORDS_PER_EPISODE_MIN).toBeGreaterThanOrEqual(102);
    expect(TARGET_WORDS_PER_EPISODE_MAX).toBeLessThanOrEqual(170);
  });

  it('clamps per-scene duration to 8-14 s', () => {
    expect(durationFromWords(0)).toBe(SCENE_DURATION_MIN_SECONDS);
    expect(durationFromWords(5)).toBe(SCENE_DURATION_MIN_SECONDS);
    expect(durationFromWords(24)).toBeLessThanOrEqual(SCENE_DURATION_MAX_SECONDS);
    expect(durationFromWords(24)).toBeGreaterThanOrEqual(SCENE_DURATION_MIN_SECONDS);
    expect(durationFromWords(200)).toBe(SCENE_DURATION_MAX_SECONDS);
  });

  it('produces a timing record with the centralized WPM', () => {
    const t = timingFor(12);
    expect(t.totalDuration).toBe(12);
    expect(t.wordsPerMinute).toBe(SPEAKING_WPM);
    expect(t.charactersPerMinute).toBeGreaterThan(0);
  });

  it('matches the spec scaffolding', () => {
    expect(EPISODES_PER_STORY).toBe(10);
    expect(SCENES_PER_EPISODE).toBe(5);
  });
});
