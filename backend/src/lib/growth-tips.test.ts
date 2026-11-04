import { getAlgorithmTipsForGenre } from './growth-tips.js';

describe('genre-specific algorithm tips', () => {
  it('returns 5 tips for every supported genre', () => {
    const genres = [
      'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
      'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
      'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
      'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
    ];
    for (const g of genres) {
      const tips = getAlgorithmTipsForGenre(g);
      expect(tips.length).toBe(5);
      for (const tip of tips) {
        expect(tip.length).toBeGreaterThan(20);
      }
    }
  });

  it('returns distinct tips for different genres', () => {
    const horror = getAlgorithmTipsForGenre('horror').join('|');
    const romance = getAlgorithmTipsForGenre('romance').join('|');
    expect(horror).not.toBe(romance);
  });

  it('falls back to fantasy for unknown genres', () => {
    const unknown = getAlgorithmTipsForGenre('totally-not-a-genre');
    const fantasy = getAlgorithmTipsForGenre('fantasy');
    expect(unknown).toEqual(fantasy);
  });
});

describe('story-specific tips with GrowthTipsContext', () => {
  it('injects story keyword into tips when title provides one', () => {
    const withCtx = getAlgorithmTipsForGenre('fantasy', { title: 'The Whispering Mirror', protagonistName: 'Mira', firstHook: 'Something moved behind the glass' });
    const withoutCtx = getAlgorithmTipsForGenre('fantasy');
    // Tips should differ when context is provided
    const different = withCtx.some((tip, i) => tip !== withoutCtx[i]);
    expect(different).toBe(true);
    // Keyword should appear in at least one tip
    const keywordAppears = withCtx.some(t => t.toLowerCase().includes('whispering'));
    expect(keywordAppears).toBe(true);
  });

  it('injects keyword from firstHook when title is absent', () => {
    const tips = getAlgorithmTipsForGenre('fantasy', { protagonistName: 'Sora', firstHook: 'The ember crown pulses with forgotten power' });
    const keyword = 'ember';
    const appears = tips.some(t => t.toLowerCase().includes(keyword));
    expect(appears).toBe(true);
  });

  it('returns unmodified tips when no story context provided', () => {
    const tips = getAlgorithmTipsForGenre('fantasy');
    expect(tips.length).toBe(5);
  });

  it('returns a copy (does not mutate the static TIPS)', () => {
    const original = getAlgorithmTipsForGenre('fantasy');
    const withCtx = getAlgorithmTipsForGenre('fantasy', { title: 'Ember Crown' });
    expect(original).not.toBe(withCtx);
    // After calling with context, calling without context should still return original
    const again = getAlgorithmTipsForGenre('fantasy');
    expect(again).toEqual(original);
  });

  it('injects keyword into posting-time tip when time slot is present', () => {
    // Use a title with a clear keyword that is NOT a stop-word and >= 4 chars
    const tips = getAlgorithmTipsForGenre('horror', { title: 'The Venom Crown', protagonistName: 'Nix', firstHook: 'Something in the shadows' });
    // Horror posting time tip contains a time slot (10 PM - 1 AM) — base tip should be
    // modified with the keyword appended
    const postingTip = tips[0];
    expect(postingTip).toMatch(/\d+\s*PM\s*-\s*\d+\s*AM/);
    // "venom" from the title should appear in the modified posting tip
    expect(postingTip).toContain('venom');
  });

  // ---------- HASHTAG INVARIANTS ----------
  // These tests ensure that the hashtag personalization never drops or
  // corrupts original hashtags — fixing the pre-fix bug where the regex
  // `(#[a-z0-9]+)\s*(#[a-z0-9]+)?\s*(#[a-z0-9]+)?` silently dropped
  // every hashtag beyond the 3rd.

  describe('hashtag invariants', () => {
    it('INVARIANT: all original hashtags survive personalization (no truncation)', () => {
      for (const genre of ['fantasy', 'romance', 'horror', 'sci-fi', 'thriller', 'mystery', 'psychological', 'comedy', 'action', 'emotional', 'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend', 'historical', 'mythology', 'slice-of-life', 'dark-fantasy', 'adventure', 'drama'] as const) {
        const base = getAlgorithmTipsForGenre(genre);
        const hashtagTip = base[3]!;
        const originalTags = hashtagTip.match(/#[a-z0-9_]+/gi) ?? [];

        // With a keyword-derived tag, all original tags must still be present
        const personal = getAlgorithmTipsForGenre(genre, {
          title: 'The Emerald Crown',
          protagonistName: 'Mira',
        });
        const personalTip = personal[3];
        for (const tag of originalTags) {
          expect(personalTip).toContain(tag);
        }

        // Without context, the tips should be unchanged
        const withoutContext = getAlgorithmTipsForGenre(genre);
        expect(withoutContext[3]).toBe(hashtagTip);
      }
    });

    it('INVARIANT: personalized tips still contain at most N+1 hashtags (N originals + 1 keyword)', () => {
      for (const genre of ['fantasy', 'horror', 'sci-fi'] as const) {
        const base = getAlgorithmTipsForGenre(genre);
        const originalCount = (base[3]!.match(/#[a-z0-9_]+/gi) ?? []).length;

        const personal = getAlgorithmTipsForGenre(genre, {
          title: 'The Whispering Crown',
          protagonistName: 'Mira',
        });
        const afterCount = (personal[3]!.match(/#[a-z0-9_]+/gi) ?? []).length;
        // Should have original + 1 keyword tag (or original if keyword is empty)
        expect(afterCount).toBeGreaterThanOrEqual(originalCount);
        expect(afterCount).toBeLessThanOrEqual(originalCount + 1);
      }
    });

    it('INVARIANT: keyword hashtag only contains valid characters (alphanumeric + underscore)', () => {
      const tips = getAlgorithmTipsForGenre('horror', {
        title: 'The Venom Crown',
        protagonistName: 'Nix',
      });
      const personalTip = tips[3]!;
      const tags = personalTip.match(/#[a-z0-9_]+/gi) ?? [];
      const keywordTag = tags.find((t) => !['#horrorshort', '#scarystory', '#animatedhorror', '#shorts', '#horror', '#animehorror', '#scary'].includes(t));
      if (keywordTag) {
        expect(keywordTag).toMatch(/^#[a-z0-9_]+$/);
      }
    });
  });
});
