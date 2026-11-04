/**
 * H18 regression: when the LLM judge is unavailable, the quality gate is
 * advisory — it must NOT throw QualityError (which previously triggered a
 * 3× full-pipeline retry storm against a judge that was still down).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../services/quality-judge.js', () => ({
  judgeStoryQuality: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../quality/index.js', () => ({
  calculateQualityPenalties: vi.fn().mockReturnValue({
    totalPenalty: 5,
    issues: ['deterministic issue for test'],
  }),
}));

vi.mock('../../../../lib/growth-tips.js', () => ({
  getAlgorithmTipsForGenre: vi.fn().mockReturnValue([]),
}));

import { stage8Quality } from './stage8-quality.js';
import type { StageContext, StageHelpers } from '../types.js';
import type { Story } from '../../../../services/types.js';

function makeStory(): Story {
  return {
    id: 's1',
    title: 'T',
    genre: 'fantasy',
    episodes: [
      {
        id: 'e1', number: 1, title: 'E1', synopsis: 's', hook: 'h', cliffhanger: 'c', duration: 55,
        scenes: [
          {
            id: 'sc1', number: 1, duration: 11, emotionalIntensity: 5,
            narration: { id: 'n1', text: 'Some narration text for the scene.', emotion: 'calm', timing: { totalDuration: 11, wordsPerMinute: 150 } },
            imagePrompt: { id: 'p1', content: 'img' },
            videoPrompt: { id: 'p2', content: 'vid' },
            cameraDirection: { type: 'static' },
            characterState: { action: 'standing' },
            environmentState: { atmosphere: 'calm' },
            transitionType: 'cut',
          },
        ],
      },
    ],
    metadata: {},
  } as unknown as Story;
}

function makeCtx(): StageContext {
  return {
    jobId: 'j',
    requestId: 'r',
    primaryGenre: 'fantasy',
    qualityFloor: 70,
    gradeFloor: 'C',
    story: makeStory(),
    episodes: makeStory().episodes,
    blueprint: { protagonistName: 'Test Hero' },
  } as unknown as StageContext;
}

const helpers = { progressEmit: vi.fn().mockResolvedValue(undefined) } as unknown as StageHelpers;

describe('H18 — judge-unavailable quality gate is advisory', () => {
  it('does NOT throw QualityError when the judge is down and penalties exist', async () => {
    // llmScore falls back to floor (70); penalties (5) make finalScore 65 < 70.
    // Pre-fix this threw QualityError; post-fix it must complete as advisory.
    const ctx = makeCtx();
    await expect(stage8Quality(ctx, helpers)).resolves.toBeUndefined();
    expect(ctx.qualityScore).toBe(65);
    expect(ctx.qualityIssues?.some((i) => i.includes('judge unavailable') || i.includes('Quality judge unavailable'))).toBe(true);
  });

  it('does NOT throw on the grade gate either when the judge is down', async () => {
    const ctx = makeCtx();
    ctx.gradeFloor = 'B';
    await expect(stage8Quality(ctx, helpers)).resolves.toBeUndefined();
  });
});
