/**
 * H4 regression tests — token accounting in episode/scene regeneration.
 *
 * Root cause:
 *   1. Double-charge: both services pre-charged a fixed estimate via
 *      checkAndRecordTokenBudget AND the AI client independently recorded the
 *      actual usage for the same jobId → every regeneration was charged twice
 *      (estimate + actual).
 *   2. scene-regeneration had NO refund wrapper, so the 409 (similarity /
 *      version-conflict) and 422 (monetization) rejection paths leaked the
 *      charged budget.
 *
 * The fix mirrors the main pipeline: a READ-ONLY checkTokenBudget() gate, the
 * AI client as the single authoritative recorder (real tokens per call,
 * tracked per jobId), refund ACTUAL spend on any failure, and clearTokenSpend
 * on success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const checkTokenBudgetMock = vi.fn();
const checkAndRecordSpy = vi.fn();
const refundMock = vi.fn();
const clearSpendMock = vi.fn();

vi.mock('./token-budget.js', () => ({
  checkTokenBudget: (...a: unknown[]) => checkTokenBudgetMock(...a),
  checkAndRecordTokenBudget: (...a: unknown[]) => checkAndRecordSpy(...a),
  refundTokenBudget: (...a: unknown[]) => refundMock(...a),
  clearTokenSpend: (...a: unknown[]) => clearSpendMock(...a),
}));

const generateEpisodeMock = vi.fn();
const generateSingleSceneMock = vi.fn();
const isSceneTooSimilarMock = vi.fn();
const similarityMock = vi.fn();
const monetizationMock = vi.fn();

vi.mock('../lib/episode-generator.js', () => ({
  generateEpisodeWithContext: (...a: unknown[]) => generateEpisodeMock(...a),
  generateSingleScene: (...a: unknown[]) => generateSingleSceneMock(...a),
  isSceneTooSimilar: (...a: unknown[]) => isSceneTooSimilarMock(...a),
}));
vi.mock('../lib/prompt-engine.js', () => ({ buildScenePrompts: vi.fn(() => null) }));
vi.mock('./similarity.js', () => ({ checkNewContentSimilarity: (...a: unknown[]) => similarityMock(...a) }));
vi.mock('../lib/copyright-filter.js', () => ({ checkMonetization: (...a: unknown[]) => monetizationMock(...a) }));
vi.mock('../lib/timing.js', () => ({
  durationFromWords: vi.fn(() => 5),
  timingFor: vi.fn(() => ({})),
  episodesPerStory: 10,
  scenesPerEpisode: 5,
}));
vi.mock('../lib/db-to-rich.js', () => ({
  toRichCharacter: vi.fn(() => ({})),
  toRichEnvironment: vi.fn(() => ({})),
}));
vi.mock('../lib/tts-normalize.js', () => ({ buildVoiceoverText: vi.fn(() => 'vo') }));
vi.mock('./generation-helpers.js', () => ({
  buildCharacterBible: vi.fn(() => ({})),
  findCharacters: vi.fn(() => ({
    protagonist: { name: 'Hero', gender: 'neutral' },
    antagonist: null,
    supporting: null,
    environment: { name: 'Forest' },
  })),
}));
vi.mock('./generation-logger.js', () => ({
  logStageComplete: vi.fn().mockResolvedValue(undefined),
  logRegeneration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/ai-client.js', () => ({
  runWithAIPipelineContext: vi.fn((_j: string, _s: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));
vi.mock('../humanization/index.js', () => ({
  humanization: { process: (t: string) => ({ text: t }) },
}));

// --- Prisma mock ---
const txEpisodeUpdate = vi.fn().mockResolvedValue({});
const txSceneUpdate = vi.fn().mockResolvedValue({});
const mockTx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  story: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
  episode: { findUnique: vi.fn().mockResolvedValue({ version: 1 }), update: txEpisodeUpdate },
  scene: { findUnique: vi.fn().mockResolvedValue({ version: 1 }), update: txSceneUpdate },
};
const mockPrisma = {
  story: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  episode: {
    findUnique: vi.fn().mockResolvedValue({ hook: 'h', cliffhanger: 'c', scenes: [] }),
    findFirst: vi.fn().mockResolvedValue({ number: 10 }),
    update: vi.fn().mockResolvedValue({}),
  },
  scene: { count: vi.fn().mockResolvedValue(5) },
  $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockTx)),
};
vi.mock('../database/prisma.js', () => ({ prisma: () => mockPrisma, __setClient: vi.fn() }));

const USER = 'user-1';

function storyForEpisode() {
  return {
    id: 'story-1',
    userId: USER,
    title: 'T',
    genre: 'fantasy',
    theme: 'th',
    characters: [],
    environments: [],
    episodes: [
      { id: 'ep-1', number: 1, title: 'E1', hook: 'h', synopsis: 's', cliffhanger: 'c', scenes: [{ id: 'sc-1', number: 1, narrationText: 'old' }] },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkTokenBudgetMock.mockResolvedValue({ ok: true, daily: {}, monthly: {} });
  refundMock.mockResolvedValue(undefined);
  similarityMock.mockResolvedValue(0.1);
  monetizationMock.mockReturnValue({ clean: true, hits: [] });
  isSceneTooSimilarMock.mockReturnValue(false);
  mockPrisma.story.findUnique.mockResolvedValue(storyForEpisode());
});

describe('regenerateEpisode — H4 token accounting', () => {
  it('success: uses read-only gate, clears spend, never double-charges or refunds', async () => {
    generateEpisodeMock.mockResolvedValue({ scenes: ['narr one', 'narr two'], hook: 'h', synopsis: 's', cliffhanger: 'c' });
    const { regenerateEpisode } = await import('./episode-regeneration.js');
    const res = await regenerateEpisode('story-1', 1, USER, 'job-ep');
    expect(res.regenerated).toBe(true);

    expect(checkTokenBudgetMock).toHaveBeenCalledTimes(1);
    // The service must NOT pre-charge an estimate (that was the double-charge).
    expect(checkAndRecordSpy).not.toHaveBeenCalled();
    expect(clearSpendMock).toHaveBeenCalledWith('job-ep');
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('similarity rejection (409): refunds the actual AI spend, does not clear', async () => {
    generateEpisodeMock.mockResolvedValue({ scenes: ['narr one'], hook: 'h', synopsis: 's', cliffhanger: 'c' });
    similarityMock.mockResolvedValue(0.95); // > 0.85 → 409
    const { regenerateEpisode } = await import('./episode-regeneration.js');
    await expect(regenerateEpisode('story-1', 1, USER, 'job-ep')).rejects.toThrow(/too similar/);

    // Refund uses (0,0) → tracked actual spend.
    expect(refundMock).toHaveBeenCalledWith('job-ep', 0, 0);
    expect(clearSpendMock).not.toHaveBeenCalled();
  });
});

describe('regenerateScene — H4 token accounting', () => {
  it('success: read-only gate, clears spend, no double-charge, no refund', async () => {
    generateSingleSceneMock.mockResolvedValue('a brand new narration that is long enough');
    const { regenerateScene } = await import('./scene-regeneration.js');
    const res = await regenerateScene('story-1', 1, 1, USER, 'job-sc');
    expect(res.regenerated).toBe(true);

    expect(checkTokenBudgetMock).toHaveBeenCalledTimes(1);
    expect(checkAndRecordSpy).not.toHaveBeenCalled();
    expect(clearSpendMock).toHaveBeenCalledWith('job-sc');
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('monetization rejection (422): refunds the actual AI spend (previously leaked)', async () => {
    generateSingleSceneMock.mockResolvedValue('a brand new narration that is long enough');
    monetizationMock.mockReturnValue({ clean: false, hits: ['blocked'] });
    const { regenerateScene } = await import('./scene-regeneration.js');
    await expect(regenerateScene('story-1', 1, 1, USER, 'job-sc')).rejects.toThrow(/Blocked terms/);

    expect(refundMock).toHaveBeenCalledWith('job-sc', 0, 0);
    expect(clearSpendMock).not.toHaveBeenCalled();
  });

  it('similarity rejection (409): refunds the actual AI spend (previously leaked)', async () => {
    generateSingleSceneMock.mockResolvedValue('a brand new narration that is long enough');
    similarityMock.mockResolvedValue(0.99);
    const { regenerateScene } = await import('./scene-regeneration.js');
    await expect(regenerateScene('story-1', 1, 1, USER, 'job-sc')).rejects.toThrow(/too similar/);

    expect(refundMock).toHaveBeenCalledWith('job-sc', 0, 0);
    expect(clearSpendMock).not.toHaveBeenCalled();
  });
});
