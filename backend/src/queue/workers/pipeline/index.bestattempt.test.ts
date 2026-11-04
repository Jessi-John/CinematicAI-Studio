/**
 * H2 regression tests — the best-effort ("publish best attempt") fallback.
 *
 * Root cause (two linked bugs):
 *   1. The retry loop threw on its final iteration (`attempt > qualityMaxRetries`),
 *      so the loop never completed normally and the QUALITY-6 bestAttempt block
 *      was DEAD CODE — every near-miss story failed to the DLQ even when it met
 *      publish_threshold.
 *   2. When that block DID run, it persisted the raw candidate captured at the
 *      moment stage 8 threw — skipping stages 9 (SEO), 10 (copyright sweep,
 *      security-critical), and 11 (embedding) with no surfaced degradation.
 *
 * The fix makes the loop exhaust naturally on QualityError (reaching the
 * fallback), and the fallback now runs runPostStage5Stages (7/9/10/11) and
 * records the degradation in metadata.qualityIssues before persisting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QualityError } from './quality-error.js';
import type { Story } from '../../../services/types.js';

// --- Spy handles (populated in beforeEach) ---
const runGenerationCoreMock = vi.fn();
const buildStageContextFromStorySpy = vi.fn();
const runPostStage5StagesSpy = vi.fn();
const createStoryMock = vi.fn();
const judgeMock = vi.fn();
const refinementPlanMock = vi.fn();

vi.mock('./orchestrator.js', () => ({
  runGenerationCore: (...a: unknown[]) => runGenerationCoreMock(...a),
  buildStageContextFromStory: (...a: unknown[]) => buildStageContextFromStorySpy(...a),
  runPostStage5Stages: (...a: unknown[]) => runPostStage5StagesSpy(...a),
}));
vi.mock('../../../database/prisma-storage.js', () => ({
  createStory: (...a: unknown[]) => createStoryMock(...a),
}));
vi.mock('../../../services/quality-judge.js', () => ({
  judgeStoryQuality: (...a: unknown[]) => judgeMock(...a),
}));
vi.mock('../../../lib/quality-refiner.js', () => ({
  generateRefinementPlan: (...a: unknown[]) => refinementPlanMock(...a),
  applyRefinementPlan: vi.fn(),
}));
vi.mock('../../../services/token-budget.js', () => ({
  checkTokenBudget: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../services/settings.js', () => ({
  getSystemSetting: vi.fn().mockImplementation(async (key: string, def: string) => {
    if (key === 'grade_floor') return 'C';
    if (key === 'auto_refinement_enabled') return 'true';
    return def;
  }),
  getSystemSettingInt: vi.fn().mockImplementation(async (key: string, def: number) => {
    if (key === 'quality_floor') return 70;
    if (key === 'publish_threshold') return 60;
    if (key === 'humanization_story_quality_retries') return 1;
    return def;
  }),
}));
vi.mock('../../../lib/timing.js', () => ({ loadTimingOverrides: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/seed-evaluator.js', () => ({ evaluateSeed: vi.fn(), enrichSeed: vi.fn() }));
vi.mock('../../../lib/watchdog.js', () => ({
  createWatchdogAbortController: vi.fn(() => ({
    fired: Promise.resolve({ fired: false }),
    controller: { signal: undefined },
    cancel: vi.fn(),
  })),
}));
vi.mock('../../../lib/ai-client.js', () => ({
  runWithAIPipelineContext: vi.fn((_j: string, _s: unknown, run: () => unknown) => run()),
}));
vi.mock('../../../queue/index.js', () => ({
  addBackgroundSeoJob: vi.fn().mockResolvedValue(undefined),
  addBackgroundEmbeddingJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../config/env.js', () => ({
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PASSWORD: 'test-redis-password',
  API_SECRET: 'test-api-secret',
  ADMIN_API_KEY: 'test-admin-api-key',
  JWT_SECRET: 'test-jwt-secret',
  e2eTestBypassEnabled: vi.fn(() => false),
  cannedModeEnabled: vi.fn(() => false),
  getStoryTokenBudgetEstimate: vi.fn(() => 0),
  getEpisodeTokenBudgetEstimate: vi.fn(() => 0),
  getSceneTokenBudgetEstimate: vi.fn(() => 0),
}));
vi.mock('./death-loop-guard.js', () => ({
  deathLoopGuard: { log: vi.fn() },
  __resetDeathLoopGuard: vi.fn(),
}));
vi.mock('../../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));

function makeCandidate(): Story {
  return {
    id: 'cand-1',
    title: 'Test Story',
    genre: 'fantasy',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    episodes: [],
    characters: [{ id: 'p', name: 'Hero', role: 'protagonist' }] as unknown as Story['characters'],
    environments: [{ name: 'Forest' }] as unknown as Story['environments'],
    metadata: {
      totalEpisodes: 0,
      totalScenes: 0,
      estimatedDuration: 0,
      targetAudience: 'all',
      monetizationScore: 0,
      viralityScore: 0,
      retentionScore: 0,
      hookStrength: 0,
      qualityIssues: [],
    },
  } as unknown as Story;
}

const baseOptions = {
  genre: ['fantasy'],
  jobId: 'job-1',
  requestId: 'req-1',
  userId: 'user-1',
};

describe('runStoryPipeline — H2 best-effort publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // qualityFloor=70, publishThreshold=60, score=65 → above publish, below floor.
    judgeMock.mockResolvedValue({ overallScore: 65, grade: 'C', subScores: {}, issue: 'weak', strength: 'ok' });
    refinementPlanMock.mockResolvedValue(null);
    buildStageContextFromStorySpy.mockImplementation((story: Story) => ({ ctx: { story }, helpers: {} }));
    runPostStage5StagesSpy.mockResolvedValue(undefined);
    createStoryMock.mockResolvedValue({ id: 'story-1' });
  });

  it('reaches the best-effort fallback and runs skipped stages 9-11 before persisting', async () => {
    const candidate = makeCandidate();
    // Every attempt fails quality with a story candidate (score 65).
    runGenerationCoreMock.mockRejectedValue(
      new QualityError('below floor', 65, 'C', ['weak'], candidate)
    );

    const { runStoryPipeline } = await import('./index.js');
    const result = await runStoryPipeline(baseOptions);

    // The fix: the fallback is now reachable and runs the post-stage-5 stages
    // (SEO/copyright/embedding) on the candidate before persisting.
    expect(runPostStage5StagesSpy).toHaveBeenCalledTimes(1);
    expect(buildStageContextFromStorySpy).toHaveBeenCalledWith(candidate, expect.anything());

    // Persisted, and the degradation is surfaced on the story record.
    expect(createStoryMock).toHaveBeenCalledTimes(1);
    const persistedArg = createStoryMock.mock.calls[0]![0] as Story;
    expect(persistedArg.metadata.qualityIssues).toEqual(
      expect.arrayContaining([expect.stringMatching(/below quality floor/i)])
    );
    expect(result.saved).toBe(true);
  });

  it('aborts the publish when stage 10 (copyright) hard-rejects — does not persist a liable row', async () => {
    const candidate = makeCandidate();
    runGenerationCoreMock.mockRejectedValue(
      new QualityError('below floor', 65, 'C', ['weak'], candidate)
    );
    runPostStage5StagesSpy.mockRejectedValue(new Error('Safety-blocked: monetization reject'));

    const { runStoryPipeline } = await import('./index.js');
    await expect(runStoryPipeline(baseOptions)).rejects.toThrow();

    // The security-critical copyright reject must prevent persistence.
    expect(createStoryMock).not.toHaveBeenCalled();
  });

  it('throws the last error when the best attempt is below the publish threshold', async () => {
    const candidate = makeCandidate();
    runGenerationCoreMock.mockRejectedValue(
      new QualityError('below floor', 65, 'C', ['weak'], candidate)
    );
    // Score 40 < publishThreshold 60 → no publish; surface the failure.
    judgeMock.mockResolvedValue({ overallScore: 40, grade: 'F', subScores: {}, issue: 'bad', strength: '' });

    const { runStoryPipeline } = await import('./index.js');
    await expect(runStoryPipeline(baseOptions)).rejects.toThrow();
    expect(runPostStage5StagesSpy).not.toHaveBeenCalled();
    expect(createStoryMock).not.toHaveBeenCalled();
  });

  it('still throws infrastructure (non-quality) errors immediately without the fallback', async () => {
    runGenerationCoreMock.mockRejectedValue(new Error('Redis connection lost'));

    const { runStoryPipeline } = await import('./index.js');
    await expect(runStoryPipeline(baseOptions)).rejects.toThrow('Redis connection lost');
    expect(runPostStage5StagesSpy).not.toHaveBeenCalled();
    expect(createStoryMock).not.toHaveBeenCalled();
  });
});
