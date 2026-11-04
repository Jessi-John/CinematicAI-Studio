import { describe, it, expect } from 'vitest';
import { ensureEpisodeWordCompliance } from './word-count-compliance.js';

const opts = {
  targetEpisodeWordsMin: 125,
  targetEpisodeWordsMax: 160,
  targetWordsPerScene: 24,
};

function total(scenes: string[]): number {
  return scenes.reduce((s, t) => s + t.trim().split(/\s+/).filter(Boolean).length, 0);
}

function count(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('ensureEpisodeWordCompliance', () => {
  it('leaves in-band episodes unchanged', () => {
    const scenes = Array.from({ length: 5 }, () => 'Word '.repeat(26).trim() + '.');
    const result = ensureEpisodeWordCompliance(scenes, opts);
    expect(result).toEqual(scenes);
    expect(total(result)).toBeGreaterThanOrEqual(opts.targetEpisodeWordsMin);
    expect(total(result)).toBeLessThanOrEqual(opts.targetEpisodeWordsMax);
  });

  it('pads an under-length episode into band deterministically', () => {
    const scenes = Array.from({ length: 5 }, () => 'a '.repeat(15).trim() + '.');
    const result = ensureEpisodeWordCompliance(scenes, opts);
    expect(total(result)).toBeGreaterThanOrEqual(opts.targetEpisodeWordsMin);
    expect(total(result)).toBeLessThanOrEqual(opts.targetEpisodeWordsMax);
  });

  it('trims an over-length episode into band', () => {
    const scenes = Array.from({ length: 5 }, () => 'The quick brown fox jumps. '.repeat(8).trim());
    const result = ensureEpisodeWordCompliance(scenes, opts);
    expect(total(result)).toBeLessThanOrEqual(opts.targetEpisodeWordsMax);
  });

  it('does not pad scenes beyond the per-scene ceiling', () => {
    const scenes = Array.from({ length: 5 }, () => 'a '.repeat(38).trim() + '.');
    const result = ensureEpisodeWordCompliance(scenes, opts);
    result.forEach((s) => {
      expect(count(s)).toBeLessThanOrEqual(40);
    });
  });

  it('is deterministic / idempotent', () => {
    const scenes = [
      'a '.repeat(20).trim() + '.',
      'b '.repeat(20).trim() + '.',
      ...Array.from({ length: 3 }, () => 'c '.repeat(20).trim() + '.'),
    ];
    const once = ensureEpisodeWordCompliance(scenes, opts);
    const twice = ensureEpisodeWordCompliance(once, opts);
    expect(twice).toEqual(once);
  });

  it('preserves all original scenes', () => {
    const scenes = Array.from({ length: 5 }, () => 'Word '.repeat(26).trim() + '.');
    const result = ensureEpisodeWordCompliance(scenes, opts);
    expect(result).toHaveLength(scenes.length);
  });

  it('uses filler-word trimming as a last resort for single-sentence scenes', () => {
    const scenes = Array.from({ length: 5 }, () =>
      'The very quick brown fox really jumps quite suddenly over the lazy dog.'.repeat(2).trim()
    );
    const result = ensureEpisodeWordCompliance(scenes, opts);
    expect(total(result)).toBeLessThanOrEqual(opts.targetEpisodeWordsMax);
  });
});
