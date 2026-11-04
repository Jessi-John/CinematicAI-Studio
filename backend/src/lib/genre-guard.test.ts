import { describe, it, expect } from 'vitest';
import {
  GENRE_GUARD_RULES,
  validateBlueprintGenre,
  buildGenreGuardCorrectionNote,
  GenreGuardViolationError,
  isGenreGuardViolationError,
  containsPhrase,
  validateEpisodeOutlineGenre,
} from './genre-guard.js';
import type { StoryBlueprint } from './episode-generator.js';
import type { Genre } from '../services/types.js';

function blueprint(overrides: Partial<StoryBlueprint> = {}): StoryBlueprint {
  return {
    title: overrides.title ?? 'Test Title',
    protagonistName: overrides.protagonistName ?? 'Aelira',
    protagonistAge: overrides.protagonistAge ?? '16',
    protagonistGender: overrides.protagonistGender ?? 'neutral',
    setting: overrides.setting ?? 'Test Setting',
    theme: overrides.theme ?? 'test theme',
    logline: overrides.logline ?? 'A test logline.',
  };
}

describe('genre-guard', () => {
  it('has a rule for every supported genre', () => {
    const genres: Genre[] = [
      'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
      'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
      'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
      'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
    ];
    for (const g of genres) {
      expect(GENRE_GUARD_RULES[g].guidance.length).toBeGreaterThan(0);
      expect(GENRE_GUARD_RULES[g].forbidden).toBeInstanceOf(Array);
    }
  });

  describe('validateBlueprintGenre', () => {
    it('rejects comedy with a ghost/phantom', () => {
      const bp = blueprint({
        title: 'The Lunchbox Phantom',
        theme: 'A student suspects a ghost is stealing lunches.',
        logline: 'A phantom haunts the cafeteria.',
      });
      const v = validateBlueprintGenre(bp, 'comedy');
      expect(v.length).toBeGreaterThan(0);
      expect(v.some((x) => x.includes('phantom'))).toBe(true);
      expect(v.some((x) => x.includes('ghost'))).toBe(true);
    });

    it('rejects slice-of-life with magic or supernatural light', () => {
      const bp = blueprint({
        title: 'The Lantern That Would Not Die',
        theme: 'A shopkeeper discovers a magical lantern that casts impossible colors.',
        logline: 'A supernatural light leads to a hidden alley.',
      });
      const v = validateBlueprintGenre(bp, 'slice-of-life');
      expect(v.some((x) => x.includes('magic'))).toBe(true);
      expect(v.some((x) => x.includes('supernatural'))).toBe(true);
    });

    it('rejects drama with a portal or impossible door', () => {
      const bp = blueprint({
        title: 'The Door That Was Not There',
        theme: 'A tenant finds a door that opens to a staircase of impossible light.',
        logline: 'An impossible door reveals a family secret.',
      });
      const v = validateBlueprintGenre(bp, 'drama');
      expect(v.some((x) => x.includes('impossible'))).toBe(true);
    });

    it('rejects romance without a relationship/love signal', () => {
      const bp = blueprint({
        title: 'The Vanishing Frequency',
        theme: 'A coder tracks a mysterious signal that predicts disasters.',
        logline: 'A protagonist uncovers a signal that should not exist.',
      });
      const v = validateBlueprintGenre(bp, 'romance');
      expect(v.length).toBeGreaterThan(0);
      expect(v.some((x) => x.includes('required'))).toBe(true);
    });

    it('accepts a clean romance with a love interest', () => {
      const bp = blueprint({
        title: 'Letters in the Static',
        theme: 'A love story about two strangers who connect over a shared radio frequency.',
        logline: 'A lonely engineer falls for a voice on the radio.',
      });
      const v = validateBlueprintGenre(bp, 'romance');
      expect(v).toEqual([]);
    });

    it('accepts a clean slice-of-life concept', () => {
      const bp = blueprint({
        title: 'The Last Bench at the River',
        theme: 'An elderly woman befriends a shy student who shares her daily bench.',
        logline: 'A small act of kindness at a riverside park changes two lives.',
      });
      const v = validateBlueprintGenre(bp, 'slice-of-life');
      expect(v).toEqual([]);
    });

    it('accepts a clean comedy concept', () => {
      const bp = blueprint({
        title: 'The Great Talent Show Disaster',
        theme: 'A bumbling student accidentally signs up for the school talent show.',
        logline: 'Hilarity ensues when a magic trick goes wrong.',
      });
      const v = validateBlueprintGenre(bp, 'comedy');
      expect(v).toEqual([]);
    });

    it('accepts a clean drama concept', () => {
      const bp = blueprint({
        title: 'The Silence Between Floors',
        theme: 'An estranged brother and sister inherit the family apartment.',
        logline: 'A family rift resurfaces when they must decide whether to sell their childhood home.',
      });
      const v = validateBlueprintGenre(bp, 'drama');
      expect(v).toEqual([]);
    });

    it('does not reject the "ai" bigram inside ordinary words (regression: mythology/dark-fantasy false positives)', () => {
      // 'ai ' normalizes to 'ai'; a raw substring check would match sAId, agAIn,
      // villAIn, remAIns etc. and reject virtually any English blueprint.
      for (const genre of ['mythology', 'dark-fantasy', 'fantasy', 'historical'] as const) {
        const bp = blueprint({
          title: 'The River Bargain',
          setting: 'A mountain village said to house ancient spirits',
          theme: 'Keeping a promise when the price rises again',
          logline: 'A river spirit remains bound to the village that betrayed it.',
        });
        const v = validateBlueprintGenre(bp, genre);
        expect(v.some((x) => x.includes('"ai "'))).toBe(false);
      }
    });

    it('still rejects a standalone "AI" reference for genres that forbid it', () => {
      const bp = blueprint({
        title: 'The River Bargain',
        setting: 'A village guided by an AI oracle',
        theme: 'Keeping a promise when the price rises again',
        logline: 'A river spirit remains bound to the village that betrayed it.',
      });
      const v = validateBlueprintGenre(bp, 'mythology');
      expect(v.some((x) => x.includes('"ai "'))).toBe(true);
    });

    it('rejects viral-trend concepts with no virality element (regression: supernatural bakery mystery shipped as viral-trend)', () => {
      const bp = blueprint({
        title: 'The Midnight Loaf Mystery',
        setting: 'A small-town bakery with a strange oven',
        theme: 'Unexpected consequences of an old recipe',
        logline: 'A baker discovers coins appearing inside her loaves at midnight.',
      });
      const v = validateBlueprintGenre(bp, 'viral-trend');
      expect(v.some((x) => x.includes('Missing required viral-trend element'))).toBe(true);
    });

    it('accepts viral-trend concepts with a modern shareable hook', () => {
      const bp = blueprint({
        title: 'One Million Views Overnight',
        setting: 'A small-town bakery',
        theme: 'The cost of unexpected fame',
        logline: 'A baker’s phone video of her recipe goes viral and the world shows up at her door.',
      });
      const v = validateBlueprintGenre(bp, 'viral-trend');
      expect(v).toEqual([]);
    });
  });

  describe('containsPhrase matching semantics', () => {
    it('matches whole words and common inflections', () => {
      expect(containsPhrase('A robot guards the gate', 'robot')).toBe(true);
      expect(containsPhrase('Two robots guard the gate', 'robot')).toBe(true);
      expect(containsPhrase('The village was cursed', 'curse')).toBe(true);
      expect(containsPhrase('The cursing sailor left', 'curse')).toBe(true);
      expect(containsPhrase('A magical lantern', 'magic')).toBe(true);
      expect(containsPhrase('He was possessed', 'possess')).toBe(true);
      expect(containsPhrase('A haunted house', 'haunt')).toBe(true);
      expect(containsPhrase('Something is escalating', 'escalate')).toBe(true);
      expect(containsPhrase('The hero of the tale', 'hero')).toBe(true);
    });

    it('matches multi-word phrases as consecutive words', () => {
      expect(containsPhrase('They built a space station in orbit', 'space station')).toBe(true);
      expect(containsPhrase('The space stations in orbit', 'space station')).toBe(true);
      expect(containsPhrase('The station in space', 'space station')).toBe(false);
      expect(containsPhrase('A serial killer stalks the city', 'serial killer')).toBe(true);
      expect(containsPhrase('Serial killers stalk the city', 'serial killer')).toBe(true);
    });

    it('never matches substrings of unrelated words', () => {
      const innocent = 'She said it again in the hallway, waiting for the villain to remain seated';
      expect(containsPhrase(innocent, 'ai ')).toBe(false);
      expect(containsPhrase(innocent, 'ai')).toBe(false);
      expect(containsPhrase('He walked toward the warship', 'war')).toBe(false);
      expect(containsPhrase('The dating app chimed', 'ai')).toBe(false);
      expect(containsPhrase('A chair in the hallway', 'ai ')).toBe(false);
      expect(containsPhrase('The portrait hung crooked', 'ai')).toBe(false);
    });
  });

  describe('guard-list lint (prevents future false-positive phrases)', () => {
    // Innocent prose that must NEVER trip any forbidden phrase in any genre.
    // If a new forbidden phrase fires here, it is a substring hazard like 'ai '.
    const INNOCENT_SENTENCES = [
      'She said it again, quite afraid, as the rain remained against the window.',
      'The villain sat in a chair in the hallway, waiting for his portrait.',
      'He walked toward the warship as the siren wailed a warning.',
      'They shared a quiet meal and talked about the weather and the harvest.',
      'A detail in the painting caught the curator’s eye at dawn.',
      'The baker kneaded dough while the children played outside.',
      'An ordinary letter arrived on a Tuesday, creased and damp.',
      'The captain maintained her course through the strait.',
    ];
    it('no forbidden phrase in any genre matches innocent prose', () => {
      for (const [genre, rule] of Object.entries(GENRE_GUARD_RULES)) {
        for (const phrase of rule.forbidden) {
          for (const sentence of INNOCENT_SENTENCES) {
            expect(
              containsPhrase(sentence, phrase),
              `forbidden phrase "${phrase}" (${genre}) false-matches innocent sentence: "${sentence}"`
            ).toBe(false);
          }
        }
      }
    });
    it('every forbidden and required phrase matches its own standalone form', () => {
      for (const [genre, rule] of Object.entries(GENRE_GUARD_RULES)) {
        for (const phrase of [...rule.forbidden, ...rule.required]) {
          expect(
            containsPhrase(phrase, phrase),
            `phrase "${phrase}" (${genre}) does not match its own text`
          ).toBe(true);
        }
      }
    });
    it('every short forbidden phrase (<=3 chars normalized) is a deliberate whole-word entry', () => {
      for (const [genre, rule] of Object.entries(GENRE_GUARD_RULES)) {
        for (const phrase of rule.forbidden) {
          const normalized = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
          if (normalized.length <= 3 && !normalized.includes(' ')) {
            // Only 'ai' is an approved short token (word-boundary matched).
            expect(normalized, `short forbidden phrase "${phrase}" (${genre}) needs review`).toBe('ai');
          }
        }
      }
    });
  });

  describe('validateEpisodeOutlineGenre (episode-level enforcement)', () => {
    it('rejects supernatural horror markers in viral-trend outlines (regression: horror episode 2)', () => {
      const text = 'The freezer door turns itself\nA ghostly voice mimics his own\nSomething breathes beneath the sacks';
      const v = validateEpisodeOutlineGenre(text, 'viral-trend');
      expect(v.some((x) => x.includes('"ghost"'))).toBe(true);
    });

    it('passes clean viral-trend outlines', () => {
      const text = 'The video hits a million views\nA crowd gathers outside the café\nShe refreshes the comments again';
      expect(validateEpisodeOutlineGenre(text, 'viral-trend')).toEqual([]);
    });

    it('does not flag ambiguous everyday words that the blueprint guard forbids', () => {
      // 'impossible' is forbidden for drama blueprints but too ambiguous for
      // episode outlines — high-precision set only.
      expect(validateEpisodeOutlineGenre('An impossible choice splits the family', 'drama')).toEqual([]);
      // 'haunting melody' contains 'haunting' — not in the precision set.
      expect(validateEpisodeOutlineGenre('A haunting melody fills the recital hall', 'comedy')).toEqual([]);
    });

    it('still catches explicit markers per genre', () => {
      expect(validateEpisodeOutlineGenre('A magical portal opens', 'drama').length).toBeGreaterThan(0);
      expect(validateEpisodeOutlineGenre('The curse spreads', 'kids').length).toBeGreaterThan(0);
      expect(validateEpisodeOutlineGenre('Blood on the floor', 'kids').length).toBeGreaterThan(0);
      expect(validateEpisodeOutlineGenre('A robot uprising begins', 'mythology').length).toBeGreaterThan(0);
      expect(validateEpisodeOutlineGenre('A ghost in the attic', 'mystery').length).toBeGreaterThan(0);
      expect(validateEpisodeOutlineGenre('A ghost in the attic', 'horror')).toEqual([]);
    });
  });

  describe('buildGenreGuardCorrectionNote', () => {
    it('includes the violations and guidance', () => {
      const note = buildGenreGuardCorrectionNote(['Forbidden: "ghost" found in concept.'], 'comedy');
      expect(note).toContain('STRICT GENRE CORRECTION');
      expect(note).toContain('Forbidden: "ghost"');
      expect(note).toContain('Comedy needs humor');
      expect(note).toContain('REQUIRED ELEMENTS');
      expect(note).toContain('FORBIDDEN ELEMENT');
    });
  });

  describe('GenreGuardViolationError', () => {
    it('is identifiable', () => {
      const err = new GenreGuardViolationError(['forbidden']);
      expect(isGenreGuardViolationError(err)).toBe(true);
      expect(isGenreGuardViolationError(new Error('other'))).toBe(false);
      expect(isGenreGuardViolationError('string')).toBe(false);
    });
  });
});
