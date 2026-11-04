import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerate = vi.fn();
const mockGetSystemSetting = vi.fn();
const mockGetSystemSettingInt = vi.fn();

vi.mock('./ai-client.js', () => ({
  generateWithMistral: (...args: unknown[]) => mockGenerate(...args),
}));
vi.mock('../services/settings.js', () => ({
  getSystemSetting: (...args: unknown[]) => mockGetSystemSetting(...args),
  getSystemSettingInt: (...args: unknown[]) => mockGetSystemSettingInt(...args),
}));
vi.mock('../services/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { evaluateSeed, enrichSeed, type SeedEvaluation } from './seed-evaluator.js';

const CRITERIA: SeedEvaluation['criteria'] = {
  originality: 60,
  clarity: 60,
  specificity: 60,
  protagonistDefinition: 60,
  conflict: 60,
  setting: 60,
  emotionalPotential: 60,
  narrativePotential: 60,
  audienceSuitability: 60,
  ambiguity: 50,
  uniqueness: 60,
  genreConformance: 60,
};

describe('seed-evaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSystemSettingInt.mockResolvedValue(50);
    mockGetSystemSetting.mockResolvedValue('true');
  });

  it('normalizes malformed AI array fields so enrichSeed cannot TypeError', async () => {
    // AI returns weaknesses as a string and strengths as null — previously
    // enrichSeed's `evaluation.weaknesses.map(...)` threw a TypeError.
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({ overallScore: 60, weaknesses: 'not-an-array', strengths: null, enrichmentSuggestion: 'add a twist' })
    );
    const evaluation = await evaluateSeed('fantasy', 'a hero seed');
    expect(evaluation.weaknesses).toEqual([]);
    expect(evaluation.strengths).toEqual([]);

    // enrichSeed must not throw on the (now normalized) evaluation.
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({ enriched: 'a hero seed with a twist added', changes: ['twist'] })
    );
    const enriched = await enrichSeed('fantasy', 'a hero seed', evaluation);
    expect(enriched).not.toBeNull();
  });

  it('injects the genre directive into the evaluation prompt', async () => {
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({
        overallScore: 60,
        criteria: { ...CRITERIA, genreConformance: 60 },
        weaknesses: [],
        strengths: [],
        enrichmentSuggestion: null,
      })
    );
    await evaluateSeed('comedy', 'a funny seed');
    const userPrompt = mockGenerate.mock.calls[0]![1] as string;
    expect(userPrompt).toContain('GENRE DEFINITION');
    expect(userPrompt.toLowerCase()).toContain('comedy:');
    expect(userPrompt.toLowerCase()).toContain('genreconformance');
  });

  it('injects the genre directive into the enrichment prompt', async () => {
    const evaluation: SeedEvaluation = {
      overallScore: 60,
      isValid: false,
      criteria: CRITERIA,
      strengths: [],
      weaknesses: ['too vague'],
      enrichmentSuggestion: 'add more detail',
    };
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({ enriched: 'enriched seed text here', changes: [] })
    );

    await enrichSeed('slice-of-life', 'a quiet seed', evaluation);

    const userPrompt = mockGenerate.mock.calls[0]![1] as string;
    expect(userPrompt).toContain('GENRE DEFINITION');
    expect(userPrompt.toLowerCase()).toContain('slice-of-life');
    expect(userPrompt.toLowerCase()).toContain('forbidden elements');
  });
});
