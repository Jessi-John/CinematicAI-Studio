import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateProtagonistRoleUniqueness,
  generateCharacterBible,
  type CharacterBible,
} from './character-bible.js';
import { generateWithMistral } from '../lib/ai-client.js';

vi.mock('../lib/ai-client.js', () => ({
  generateWithMistral: vi.fn(),
}));

vi.mock('./generation-logger.js', () => ({
  logFallback: vi.fn().mockResolvedValue(undefined),
}));

function makeBible(relationships: Record<string, string>): CharacterBible {
  return {
    speechPatterns: 'calm',
    clothing: 'robes',
    facialFeatures: 'sharp eyes',
    emotions: ['curiosity'],
    relationships,
    catchphrases: [],
    physicalMannerisms: 'none',
    gender: 'neutral',
  };
}

describe('validateProtagonistRoleUniqueness', () => {
  it('passes when no seed is provided', () => {
    const bible = makeBible({ Lirael: 'a young cartographer' });
    expect(validateProtagonistRoleUniqueness(bible, undefined)).toEqual({ valid: true });
  });

  it('passes when relationships are complementary', () => {
    const bible = makeBible({
      Lirael: 'a mentor and former explorer',
      Kael: 'a rival thief from the old guild',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(true);
    expect(result.rolePhrase).toBe('cartographer');
  });

  it('fails when a supporting character shares the protagonist role', () => {
    const bible = makeBible({
      Lirael: 'a young cartographer who charts the floating islands',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts?.[0]).toMatchObject({
      relationshipName: 'Lirael',
      matchedKeyword: 'cartographer',
    });
  });

  it('fails on known synonyms of the protagonist role', () => {
    const bible = makeBible({
      Mara: 'a brilliant mapmaker who knows every hidden path',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(false);
    expect(result.conflicts?.[0]?.matchedKeyword).toBe('mapmaker');
  });

  it('matches plural forms of the role', () => {
    const bible = makeBible({
      Twins: 'cartographers by trade',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(false);
  });

  it('strips setting words from the seed before comparing', () => {
    const bible = makeBible({
      City: 'the sky-city itself',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(true);
  });

  it('rejects role matches in relationship names', () => {
    const bible = makeBible({
      'The Cartographer': 'a helpful guide',
    });
    const result = validateProtagonistRoleUniqueness(bible, 'a cartographer in a sky-city');
    expect(result.valid).toBe(false);
  });
});

describe('generateCharacterBible retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first bible when validation passes', async () => {
    const validBible = makeBible({ Mentor: 'a wise old explorer' });
    vi.mocked(generateWithMistral).mockResolvedValueOnce(JSON.stringify(validBible));

    const result = await generateCharacterBible({
      name: 'Arlo',
      genre: 'fantasy',
      setting: 'a sky-city',
      role: 'protagonist',
      seed: 'a cartographer in a sky-city',
    });

    expect(result.relationships).toEqual({ Mentor: 'a wise old explorer' });
    expect(generateWithMistral).toHaveBeenCalledTimes(1);
  });

  it('retries when validation fails and returns valid second bible', async () => {
    const invalidBible = makeBible({ Lirael: 'a young cartographer' });
    const validBible = makeBible({ Lirael: 'a rival explorer' });
    vi.mocked(generateWithMistral)
      .mockResolvedValueOnce(JSON.stringify(invalidBible))
      .mockResolvedValueOnce(JSON.stringify(validBible));

    const result = await generateCharacterBible({
      name: 'Arlo',
      genre: 'fantasy',
      setting: 'a sky-city',
      role: 'protagonist',
      seed: 'a cartographer in a sky-city',
    });

    expect(result.relationships).toEqual({ Lirael: 'a rival explorer' });
    expect(generateWithMistral).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(generateWithMistral).mock.calls[1]?.[1] as string;
    expect(secondPrompt).toContain('CORRECTION');
    expect(secondPrompt).toContain('cartographer');
  });

  it('falls back to default bible after exhausting retries', async () => {
    const invalidBible = makeBible({ Lirael: 'a young cartographer' });
    vi.mocked(generateWithMistral).mockResolvedValue(JSON.stringify(invalidBible));

    const result = await generateCharacterBible({
      name: 'Arlo',
      genre: 'fantasy',
      setting: 'a sky-city',
      role: 'protagonist',
      seed: 'a cartographer in a sky-city',
    });

    expect(result.relationships).toEqual({});
    expect(generateWithMistral).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
