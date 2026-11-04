import { describe, it, expect } from 'vitest';
import type { Character, Environment, Story } from '@prisma/client';
import { buildCharacterBible, findCharacters, jsonToRecord } from './generation-helpers.js';

function character(overrides: Partial<Character>): Character {
  return {
    id: 'character-1',
    name: 'Default Character',
    description: 'A character',
    appearance: 'A description',
    personality: 'A personality',
    role: 'minor',
    speechPatterns: null,
    clothing: null,
    facialFeatures: null,
    emotions: [],
    relationships: null,
    catchphrases: [],
    physicalMannerisms: null,
    gender: null,
    storyId: 'story-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Character;
}

function environment(overrides: Partial<Environment>): Environment {
  return {
    id: 'environment-1',
    name: 'Default Environment',
    description: 'A setting',
    type: 'exterior',
    timeOfDay: 'dusk',
    weather: 'clear',
    mood: 'calm',
    keyFeatures: ['trees'],
    colorPalette: ['green'],
    lighting: {
      primary: 'soft',
      ambient: 'warm',
      colorTemperature: 'neutral',
      shadows: 'soft',
    },
    storyId: 'story-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Environment;
}

describe('jsonToRecord', () => {
  it('keeps only string-valued entries', () => {
    expect(jsonToRecord({ ally: 'Mira', rival: 42, mentor: 'Oda', nested: { a: 'b' } })).toEqual({
      ally: 'Mira',
      mentor: 'Oda',
    });
  });

  it('returns an empty record for non-object input', () => {
    expect(jsonToRecord(null)).toEqual({});
    expect(jsonToRecord(['a', 'b'])).toEqual({});
    expect(jsonToRecord('text')).toEqual({});
  });
});

describe('buildCharacterBible', () => {
  it('returns undefined when the story has no protagonist', () => {
    expect(buildCharacterBible(undefined)).toBeUndefined();
  });

  it('preserves protagonist continuity fields when present', () => {
    const protagonist = character({
      role: 'protagonist',
      speechPatterns: 'Quiet, precise',
      clothing: 'A patched blue coat',
      facialFeatures: 'A scar above one eyebrow',
      emotions: ['resolve', 'grief'],
      relationships: { ally: 'Mira' },
      catchphrases: ['"Not yet."'],
      physicalMannerisms: 'Taps two fingers before speaking',
      gender: 'female',
    });

    expect(buildCharacterBible(protagonist)).toEqual({
      speechPatterns: 'Quiet, precise',
      clothing: 'A patched blue coat',
      facialFeatures: 'A scar above one eyebrow',
      emotions: ['resolve', 'grief'],
      relationships: { ally: 'Mira' },
      catchphrases: ['"Not yet."'],
      physicalMannerisms: 'Taps two fingers before speaking',
      gender: 'female',
    });
  });

  it('fills safe defaults and normalizes an unknown gender', () => {
    const protagonist = character({ role: 'protagonist', gender: 'unknown' });

    const bible = buildCharacterBible(protagonist);

    expect(bible?.speechPatterns).toBe('Kind-hearted, curious');
    expect(bible?.clothing).toBe('simple comfortable clothing');
    expect(bible?.facialFeatures).toBe('Expressive big eyes');
    expect(bible?.emotions).toEqual(['curiosity', 'determination', 'wonder']);
    expect(bible?.relationships).toEqual({});
    expect(bible?.catchphrases).toEqual([]);
    expect(bible?.physicalMannerisms).toBe('thoughtful pauses');
    expect(bible?.gender).toBe('neutral');
  });
});

describe('findCharacters', () => {
  it('selects the protagonist, antagonist, supporting cast, and primary environment', () => {
    const story = {
      id: 'story-1',
      characters: [
        character({ id: 'support', role: 'supporting' }),
        character({ id: 'hero', role: 'protagonist' }),
        character({ id: 'villain', role: 'antagonist' }),
        character({ id: 'extra', role: 'minor' }),
      ],
      environments: [
        environment({ id: 'primary' }),
        environment({ id: 'secondary' }),
      ],
    } as unknown as Story & { characters: Character[]; environments: Environment[] };

    const result = findCharacters(story);

    expect(result.protagonist?.id).toBe('hero');
    expect(result.antagonist?.id).toBe('villain');
    expect(result.supporting?.id).toBe('support');
    expect(result.environment?.id).toBe('primary');
  });

  it('returns undefined for roles the story does not contain', () => {
    const story = {
      id: 'story-1',
      characters: [character({ role: 'protagonist' })],
      environments: [],
    } as unknown as Story & { characters: Character[]; environments: Environment[] };

    const result = findCharacters(story);

    expect(result.protagonist?.role).toBe('protagonist');
    expect(result.antagonist).toBeUndefined();
    expect(result.supporting).toBeUndefined();
    expect(result.environment).toBeUndefined();
  });
});
