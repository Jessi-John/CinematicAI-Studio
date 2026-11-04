import { STYLE_PACKS, getStylePack } from './style-packs.js';

describe('Style Packs', () => {
  it('covers every declared genre', () => {
    const required = [
      'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
      'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
      'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
      'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
    ];
    for (const g of required) {
      expect(STYLE_PACKS).toHaveProperty(g);
    }
  });

  it('every pack has the required fields populated', () => {
    for (const [genre, pack] of Object.entries(STYLE_PACKS)) {
      expect(pack.artDirection.length).toBeGreaterThan(20);
      expect(pack.lightingPalette.length).toBeGreaterThan(10);
      expect(pack.colorPalette.length).toBeGreaterThanOrEqual(3);
      expect(pack.cameraVocabulary.length).toBeGreaterThanOrEqual(5);
      expect(pack.atmosphericEffects.length).toBeGreaterThanOrEqual(3);
      expect(pack.musicMoods.length).toBeGreaterThanOrEqual(3);
      expect(pack.soundDesign.length).toBeGreaterThanOrEqual(3);
      expect(pack.moodWords.length).toBeGreaterThanOrEqual(2);
      expect(pack.defaultEnvironment.keyFeatures.length).toBeGreaterThanOrEqual(2);
      // Sanity: shadows enum
      expect(['soft', 'hard', 'dramatic']).toContain(pack.shadowStyle);
      void genre; // suppress unused param lint in tests
    }
  });

  it('horror and fantasy have distinctly different palettes', () => {
    const fantasy = STYLE_PACKS.fantasy.colorPalette.join(' ').toLowerCase();
    const horror = STYLE_PACKS.horror.colorPalette.join(' ').toLowerCase();
    expect(fantasy).not.toBe(horror);
    expect(horror).toMatch(/cold|black|sickly|desaturated/);
    expect(fantasy).toMatch(/green|gold|blue/);
  });

  it('unknown genre falls back to fantasy', () => {
    expect(getStylePack('utterly-unknown')).toBe(STYLE_PACKS.fantasy);
  });

  it('no style pack mentions any tracked IP-tied phrase', () => {
    // Lock-in: the worker's own copyright redactor would otherwise blank out
    // these lines in image prompts. Keep style packs IP-clean.
    const tracked = [
      /studio[-\s]?ghibli/i,
      /spirited away/i,
      /pikachu/i,
      /naruto/i,
      /totoro/i,
      /attack on titan/i,
      /demon slayer/i,
      /one piece/i,
      /dragon ball/i,
    ];
    for (const [genre, pack] of Object.entries(STYLE_PACKS)) {
      const haystack = JSON.stringify(pack);
      for (const re of tracked) {
        expect(haystack).not.toMatch(re);
        void genre;
      }
    }
  });
});
