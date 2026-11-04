import { describe, it, expect } from 'vitest';
import {
  GENRE_DIRECTIVES,
  getGenreDirective,
  formatGenreDirective,
  formatGenreDirectiveForEpisode,
  isGenreDirectiveKnown,
  KNOWN_GENRES,
} from './genre-directives.js';
import type { Genre } from '../services/types.js';

function titleCaseGenre(genre: Genre): string {
  if (genre === 'sci-fi') return 'Science fiction';
  if (genre === 'dark-fantasy') return 'Dark fantasy';
  return genre.charAt(0).toUpperCase() + genre.slice(1);
}

describe('genre-directives', () => {
  it('has a directive for every known Genre', () => {
    const expected: Genre[] = [
      'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
      'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
      'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
      'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
    ];
    for (const g of expected) {
      expect(GENRE_DIRECTIVES[g].definition).toContain(titleCaseGenre(g));
      expect(GENRE_DIRECTIVES[g].mustInclude.length).toBeGreaterThan(0);
      expect(GENRE_DIRECTIVES[g].mustAvoid.length).toBeGreaterThan(0);
      expect(GENRE_DIRECTIVES[g].tone.length).toBeGreaterThan(0);
      expect(GENRE_DIRECTIVES[g].exampleThemes.length).toBeGreaterThan(0);
      expect(GENRE_DIRECTIVES[g].conflictNotes.length).toBeGreaterThan(0);
      expect(GENRE_DIRECTIVES[g].settingNotes.length).toBeGreaterThan(0);
    }
  });

  it('KNOWN_GENRES matches the directive keys', () => {
    expect(KNOWN_GENRES.length).toBe(21);
    expect(new Set(KNOWN_GENRES).size).toBe(21);
    for (const g of KNOWN_GENRES) {
      expect(GENRE_DIRECTIVES[g].definition).toContain(titleCaseGenre(g));
    }
  });

  it('isGenreDirectiveKnown recognizes known and unknown genres', () => {
    expect(isGenreDirectiveKnown('comedy')).toBe(true);
    expect(isGenreDirectiveKnown('slice-of-life')).toBe(true);
    expect(isGenreDirectiveKnown('romance')).toBe(true);
    expect(isGenreDirectiveKnown('drama')).toBe(true);
    expect(isGenreDirectiveKnown('unknown')).toBe(false);
    expect(isGenreDirectiveKnown('')).toBe(false);
  });

  it('getGenreDirective is case-insensitive', () => {
    expect(getGenreDirective('COMEDY').definition).toBe(GENRE_DIRECTIVES.comedy.definition);
    expect(getGenreDirective('Slice-Of-Life').definition).toBe(
      GENRE_DIRECTIVES['slice-of-life'].definition
    );
  });

  it('getGenreDirective returns baseline for unknown genres', () => {
    const d = getGenreDirective('cyber-western');
    expect(d.definition).toContain('cinematic anime-style story');
  });

  describe('formatGenreDirective', () => {
    it('includes the definition and required elements', () => {
      const out = formatGenreDirective('comedy');
      expect(out).toContain('Comedy:');
      expect(out).toContain('REQUIRED ELEMENTS');
      expect(out).toContain('FORBIDDEN ELEMENTS');
      expect(out).toContain('TONE:');
      expect(out).toContain('YOUTUBE MONETIZATION RULES');
    });

    it('explicitly forbids horror for comedy', () => {
      const out = formatGenreDirective('comedy');
      expect(out.toLowerCase()).toContain('horror');
      expect(out.toLowerCase()).toContain('dread');
    });

    it('explicitly forbids supernatural for slice-of-life', () => {
      const out = formatGenreDirective('slice-of-life');
      expect(out.toLowerCase()).toContain('supernatural');
      expect(out.toLowerCase()).toContain('ghosts');
      expect(out.toLowerCase()).toContain('mundane');
    });

    it('requires a romantic connection for romance', () => {
      const out = formatGenreDirective('romance');
      expect(out.toLowerCase()).toContain('romantic connection');
      expect(out.toLowerCase()).toContain('love');
    });

    it('requires grounded human conflict for drama', () => {
      const out = formatGenreDirective('drama');
      expect(out.toLowerCase()).toContain('grounded');
      expect(out.toLowerCase()).toContain('human conflict');
    });

    it('viral-trend centers modern shareable hooks and bans supernatural horror (regression: horror blueprint shipped as viral-trend)', () => {
      const d = GENRE_DIRECTIVES['viral-trend'];
      expect(d.definition).toContain('internet');
      expect(d.mustAvoid.join(' ')).toMatch(/supernatural|ghost|curse|haunted/);
      expect(d.conflictNotes).not.toMatch(/glitch, a mystery, a countdown/);
      expect(d.conflictNotes.toLowerCase()).toContain('never from supernatural forces');
    });
  });

  describe('formatGenreDirectiveForEpisode', () => {
    it('produces a compact, episode-specific directive', () => {
      const out = formatGenreDirectiveForEpisode('comedy');
      expect(out).toContain('GENRE: comedy');
      expect(out).toContain('DEFINITION:');
      expect(out).toContain('REQUIRED:');
      expect(out).toContain('AVOID:');
      expect(out).toContain('TONE:');
      expect(out).toContain('CONFLICT:');
      expect(out).toContain('SETTING:');
    });
  });
});
