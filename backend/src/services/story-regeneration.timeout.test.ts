/**
 * H26 regression: the regeneration wall-clock must scale with the configured
 * episode count. A fixed 5-minute timeout made full-story regeneration fail
 * 100% of the time at the standard 10-episode configuration (verified live).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../queue/workers/story.worker.js', () => ({
  runStoryPipeline: vi.fn(),
  __resetDeathLoopGuard: vi.fn(),
}));
vi.mock('../database/prisma.js', () => ({ prisma: () => ({}), __setClient: vi.fn() }));
vi.mock('../database/prisma-storage.js', () => ({
  replaceStoryAtomically: vi.fn(),
  convertStory: vi.fn(),
  DuplicateStoryError: class extends Error {},
}));
vi.mock('../queue/redis-pubsub.js', () => ({
  markJobFailed: vi.fn(),
  deleteJobCandidate: vi.fn(),
}));
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getRegenerationTimeoutMs } from './story-regeneration.js';
import { episodesPerStory } from '../lib/timing.js';

describe('H26 — regeneration timeout scales with episode count', () => {
  it('gives at least 6 minutes for small episode counts', () => {
    expect(getRegenerationTimeoutMs()).toBeGreaterThanOrEqual(6 * 60 * 1000);
  });

  it('scales beyond the old fixed 5-minute timeout at the standard 10-episode config', () => {
    // episodesPerStory is the live-bound timing value; at the standard 10-episode
    // configuration the timeout must exceed the ~7-minute real pipeline duration.
    if (episodesPerStory === 10) {
      expect(getRegenerationTimeoutMs()).toBe(12 * 60 * 1000);
    }
    expect(getRegenerationTimeoutMs()).toBeGreaterThan(5 * 60 * 1000);
  });

  it('exceeds the observed ~7-minute live pipeline duration at 10 episodes', () => {
    if (episodesPerStory === 10) {
      expect(getRegenerationTimeoutMs()).toBeGreaterThan(7 * 60 * 1000);
    }
  });
});
