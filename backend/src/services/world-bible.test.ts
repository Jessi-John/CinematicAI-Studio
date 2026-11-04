import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ai-client.js', () => ({
  generateWithMistral: vi.fn(),
}));

vi.mock('../database/prisma.js', () => ({
  prisma: vi.fn(),
}));

vi.mock('../lib/copyright-filter.js', () => ({
  checkText: vi.fn(() => ({ clean: true, hits: [] })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateWithMistral } from '../lib/ai-client.js';
import { checkText } from '../lib/copyright-filter.js';
import { generateWorldBible } from './world-bible.js';

const INPUT = {
  genre: 'fantasy',
  setting: 'A drowned city beneath a frozen moon',
  protagonistName: 'Iri',
  theme: 'letting go of a borrowed destiny',
};

const VALID_AI_RESPONSE = {
  antagonist: {
    name: 'The Ashen Archivist',
    description: 'Keeper of a library that rewrites the past',
    appearance: 'Grey robes, ink-stained fingers, a lantern of trapped memories',
    personality: 'Patient, possessive, terrified of being forgotten',
    role: 'antagonist',
    speechPatterns: 'Soft, precise, always citing a source',
    clothing: 'Layered grey robes and a brass reading chain',
    facialFeatures: 'Ink-flecked cheek, silver eyes, a burn scar on one temple',
    emotions: ['possessiveness', 'grief'],
    catchphrases: ['"Every story is a debt."'],
    physicalMannerisms: 'Smooths a page before speaking',
  },
  supporting: {
    name: 'Mira of the Low Tide',
    description: 'A ferrywoman who remembers the city before it sank',
    appearance: 'Oilskin coat, lantern, salt-crusted braid',
    personality: 'Wry, practical, loyal',
    role: 'supporting',
    speechPatterns: 'Short sentences and dry observations',
    clothing: 'Patched oilskin and a red scarf',
    facialFeatures: 'Freckles, a crooked smile, one clouded eye',
    emotions: ['warmth', 'wariness'],
    catchphrases: ['"The tide always comes back."'],
    physicalMannerisms: 'Taps the tiller twice before turning',
  },
  environments: [
    {
      name: 'The Drowned Archive',
      description: 'A flooded library where shelves rise from black water',
      type: 'interior',
      timeOfDay: 'eternal night',
      weather: 'still, cold air',
      mood: 'hushed dread',
      keyFeatures: ['submerged shelves', 'floating lanterns', 'ink clouds'],
      colorPalette: ['slate blue', 'ink black', 'lantern gold'],
      lighting: {
        primary: 'lantern light from below',
        ambient: 'cold blue bounce off the water',
        colorTemperature: 'cool',
        shadows: 'dramatic',
      },
    },
    {
      name: 'The Frozen Moon Terrace',
      description: 'A wind-scoured terrace above the drowned city',
      type: 'exterior',
      timeOfDay: 'blue hour',
      weather: 'freezing mist',
      mood: 'lonely resolve',
      keyFeatures: ['cracked flagstones', 'frozen railings', 'distant lighthouse'],
      colorPalette: ['pale cyan', 'frost white', 'rust'],
      lighting: {
        primary: 'diffuse moonlight',
        ambient: 'mist-scattered fill',
        colorTemperature: 'cold',
        shadows: 'soft',
      },
    },
    {
      name: 'The Drowned Archive',
      description: 'Duplicate entry that must be deduplicated by name',
      type: 'interior',
      timeOfDay: 'night',
      weather: 'still',
      mood: 'eerie',
      keyFeatures: ['shelves'],
      colorPalette: ['blue'],
      lighting: {
        primary: 'lantern',
        ambient: 'none',
        colorTemperature: 'cool',
        shadows: 'soft',
      },
    },
  ],
};

describe('generateWorldBible', () => {
  beforeEach(() => {
    vi.mocked(generateWithMistral).mockReset();
    vi.mocked(checkText).mockReturnValue({ clean: true, hits: [], redacted: '' });
  });

  it('returns the AI-designed world bible and deduplicates environments by name', async () => {
    vi.mocked(generateWithMistral).mockResolvedValue(JSON.stringify(VALID_AI_RESPONSE));

    const result = await generateWorldBible(INPUT);

    expect(result.antagonist.name).toBe('The Ashen Archivist');
    expect(result.antagonist.role).toBe('antagonist');
    expect(result.supporting.name).toBe('Mira of the Low Tide');
    expect(result.supporting.role).toBe('supporting');
    expect(result.environments).toHaveLength(2);
    expect(result.environments.map((environment) => environment.name)).toEqual([
      'The Drowned Archive',
      'The Frozen Moon Terrace',
    ]);
  });

  it('keeps the singular primary environment in sync with environments[0]', async () => {
    vi.mocked(generateWithMistral).mockResolvedValue(JSON.stringify(VALID_AI_RESPONSE));

    const result = await generateWorldBible(INPUT);

    expect(result.environment.name).toBe(result.environments[0]?.name);
    expect(result.environment.lighting).toEqual(result.environments[0]?.lighting);
  });

  it('falls back to genre archetypes when the AI provider fails', async () => {
    vi.mocked(generateWithMistral).mockRejectedValue(new Error('provider unavailable'));

    const result = await generateWorldBible(INPUT);

    expect(result.antagonist.name.length).toBeGreaterThan(0);
    expect(result.supporting.name.length).toBeGreaterThan(0);
    expect(result.environments.length).toBeGreaterThanOrEqual(2);
    expect(result.environment.name).toBe(result.environments[0]?.name);
    // The fallback clones each environment so later mutation of one entry
    // cannot leak into the other.
    expect(result.environments[0]?.lighting).not.toBe(result.environments[1]?.lighting);
  });

  it('falls back when generated names contain blocked copyrighted terms', async () => {
    vi.mocked(generateWithMistral).mockResolvedValue(JSON.stringify(VALID_AI_RESPONSE));
    vi.mocked(checkText).mockReturnValue({ clean: false, hits: ['blocked-name'], redacted: '[redacted]' });

    const result = await generateWorldBible(INPUT);

    expect(result.antagonist.name).not.toBe('The Ashen Archivist');
    expect(result.supporting.name).not.toBe('Mira of the Low Tide');
    expect(result.environments.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back when the AI response is not valid JSON', async () => {
    vi.mocked(generateWithMistral).mockResolvedValue('this is not JSON');

    const result = await generateWorldBible(INPUT);

    expect(result.antagonist.role).toBe('antagonist');
    expect(result.supporting.role).toBe('supporting');
    expect(result.environments.length).toBeGreaterThanOrEqual(1);
  });
});
