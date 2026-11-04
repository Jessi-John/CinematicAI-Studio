import { buildStoryFromEpisodes, cleanNarration } from './story-builder.js';

function makeEpisode(n: number) {
  return {
    title: `Episode ${n}`,
    hook: `Hook ${n}`,
    synopsis: `Synopsis ${n}`,
    scenes: [
      'Lira presses her hand to the cold glass and feels the room shift around her.',
      'A door she does not remember opens at the end of the hall.',
      'She walks through, breath held, and the floor breathes back.',
      'Something in the dark recognises her name.',
      'She steps forward anyway, because there is nowhere else to go.',
    ],
    cliffhanger: `Cliff ${n}`,
    episodeSummary: `Summary ${n}`,
  };
}

describe('buildStoryFromEpisodes', () => {
  it('produces 10 episodes with 5 scenes each', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    expect(story.episodes.length).toBe(10);
    for (const ep of story.episodes) {
      expect(ep.scenes.length).toBe(5);
    }
  });

  it('every episode lands within the 8-14s/scene range and 40-70s episode range', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    for (const ep of story.episodes) {
      for (const sc of ep.scenes) {
        expect(sc.duration).toBeGreaterThanOrEqual(8);
        expect(sc.duration).toBeLessThanOrEqual(14);
      }
      expect(ep.duration).toBeGreaterThanOrEqual(40);
      expect(ep.duration).toBeLessThanOrEqual(70);
    }
  });

  it('produces a TTS-clean voiceoverText with no stage labels', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    for (const ep of story.episodes) {
      // voiceoverText is a non-empty string after expansion (we should have
      // a hook + 5 scenes + cliffhanger, well above the empty minimum).
      expect(ep.voiceoverText?.length).toBeGreaterThan(50);
      expect(ep.voiceoverText).not.toMatch(/\[HOOK\]/);
      expect(ep.voiceoverText).not.toMatch(/\[CLIFFHANGER\]/);
      expect(ep.voiceoverText).not.toMatch(/\[Scene/);
      // Hook plus 5 scenes plus cliffhanger should be present.
      expect((ep.voiceoverText || '').length).toBeGreaterThan(40);
    }
  });

  it('uses the centralized timing constants (145 WPM)', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    for (const ep of story.episodes) {
      for (const sc of ep.scenes) {
        expect(sc.narration.timing.wordsPerMinute).toBe(145);
        expect(sc.narration.timing.totalDuration).toBe(sc.duration);
      }
    }
  });

  it('image prompts reference the protagonist and the actual scene narration', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    const sample = story.episodes[0]!.scenes[0]!;
    expect(sample.imagePrompt.content).toContain('Lira');
    expect(sample.imagePrompt.content.toLowerCase()).toMatch(/scene moment/);
    // Horror palette terms appear:
    expect(sample.imagePrompt.content.toLowerCase()).toMatch(/cold|chiaroscuro|dread|low-key|fog|sickly|harsh/);
  });

  it('voiceover script per episode contains HOOK and CLIFFHANGER markers', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1));
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes,
    });
    for (const ep of story.episodes) {
      expect(ep.voiceoverScript).toMatch(/\[HOOK\]/);
      expect(ep.voiceoverScript).toMatch(/\[CLIFFHANGER\]/);
    }
  });

  it('genre-distinct music suggestions', () => {
    const horror = buildStoryFromEpisodes({
      title: 'A',
      genre: 'horror',
      theme: 't',
      protagonistName: 'Lira',
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1)),
    });
    const romance = buildStoryFromEpisodes({
      title: 'B',
      genre: 'romance',
      theme: 't',
      protagonistName: 'Lira',
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1)),
    });
    expect(horror.episodes[0]!.musicSuggestions?.[0]).not.toBe(
      romance.episodes[0]!.musicSuggestions?.[0]
    );
  });
});

// BUG-004: character-bible fields must be persisted to the in-memory Story
// for ALL three characters. Previously the protagonist's structured fields
// (speechPatterns/clothing/facialFeatures/etc.) were not copied onto the
// built Character object, leaving DB rows with NULL columns even when the
// AI returned rich character-bible data. The protagonist and ant/sup now
// both receive their structured fields when characterBible/worldBible are
// provided. The world-bible fallback in story.worker.ts also includes
// these fields so the JSON path is not the only one that produces them.
describe('character bible fields on built characters (BUG-004)', () => {
  const sampleBible = {
    speechPatterns: 'measured, weighted, with old-fashioned pauses',
    clothing: 'long earth-toned cloak, patched boots, leather satchel',
    facialFeatures: 'angular face, deep-set eyes, thin scar above eyebrow',
    emotions: ['resolve', 'quiet grief'],
    relationships: {},
    catchphrases: ['Two paths. Same destination.'],
    physicalMannerisms: 'touches scar when thinking',
    gender: 'female' as const,
  };
  const sampleWorldBible = {
    antagonist: {
      name: 'Hollow Sovereign',
      description: 'A faded ruler',
      appearance: 'tattered robes, gold mask',
      personality: 'patient, possessive',
      role: 'antagonist' as const,
      speechPatterns: 'slow, ceremonial',
      clothing: 'faded gold robes',
      facialFeatures: 'gaunt, hollowed cheeks',
      emotions: ['possessiveness'],
      catchphrases: ['The old ways wait.'],
      physicalMannerisms: 'touches mask when troubled',
    },
    supporting: {
      name: 'Ren the Wayfinder',
      description: 'A pragmatic guide',
      appearance: 'travel-stained cloak',
      personality: 'plainspoken, dryly humorous',
      role: 'supporting' as const,
      speechPatterns: 'short, dry sentences',
      clothing: 'hooded cloak, patched boots',
      facialFeatures: 'weathered, crow-foot wrinkles',
      emotions: ['dry amusement'],
      catchphrases: ['Two paths. Same destination.'],
      physicalMannerisms: 'rolls a small stone',
    },
    environment: {
      name: 'Forgotten Library',
      description: 'A vast library',
      type: 'interior',
      timeOfDay: 'varied',
      weather: 'still',
      mood: 'solemn',
      keyFeatures: ['tall shelves'],
      colorPalette: ['sepia'],
      lighting: {
        primary: 'motivated by candles',
        ambient: 'soft fill',
        colorTemperature: 'warm',
        shadows: 'soft' as const,
      },
    },
    environments: [
      {
        name: 'Forgotten Library',
        description: 'A vast library',
        type: 'interior',
        timeOfDay: 'varied',
        weather: 'still',
        mood: 'solemn',
        keyFeatures: ['tall shelves'],
        colorPalette: ['sepia'],
        lighting: {
          primary: 'motivated by candles',
          ambient: 'soft fill',
          colorTemperature: 'warm',
          shadows: 'soft' as const,
        },
      },
    ],
  };

  it('protagonist gets structured fields from characterBible', () => {
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1)),
      characterBible: sampleBible,
    });
    const protagonist = story.characters.find((c) => c.role === 'protagonist')!;
    expect(protagonist.speechPatterns).toBe(sampleBible.speechPatterns);
    expect(protagonist.clothing).toBe(sampleBible.clothing);
    expect(protagonist.facialFeatures).toBe(sampleBible.facialFeatures);
    expect(protagonist.emotions).toEqual(sampleBible.emotions);
    expect(protagonist.catchphrases).toEqual(sampleBible.catchphrases);
    expect(protagonist.physicalMannerisms).toBe(sampleBible.physicalMannerisms);
  });

  it('antagonist and supporting get structured fields from worldBible', () => {
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1)),
      characterBible: sampleBible,
      worldBible: sampleWorldBible,
    });
    const antagonist = story.characters.find((c) => c.role === 'antagonist')!;
    const supporting = story.characters.find((c) => c.role === 'supporting')!;
    expect(antagonist.speechPatterns).toBe(sampleWorldBible.antagonist.speechPatterns);
    expect(antagonist.clothing).toBe(sampleWorldBible.antagonist.clothing);
    expect(antagonist.facialFeatures).toBe(sampleWorldBible.antagonist.facialFeatures);
    expect(antagonist.emotions).toEqual(sampleWorldBible.antagonist.emotions);
    expect(antagonist.catchphrases).toEqual(sampleWorldBible.antagonist.catchphrases);
    expect(antagonist.physicalMannerisms).toBe(sampleWorldBible.antagonist.physicalMannerisms);
    expect(supporting.speechPatterns).toBe(sampleWorldBible.supporting.speechPatterns);
    expect(supporting.clothing).toBe(sampleWorldBible.supporting.clothing);
    expect(supporting.facialFeatures).toBe(sampleWorldBible.supporting.facialFeatures);
    expect(supporting.emotions).toEqual(sampleWorldBible.supporting.emotions);
    expect(supporting.catchphrases).toEqual(sampleWorldBible.supporting.catchphrases);
    expect(supporting.physicalMannerisms).toBe(sampleWorldBible.supporting.physicalMannerisms);
  });

  it('protagonist structured fields are conditionally included based on characterBible (fallback does not crash)', () => {
    // When characterBible is omitted, optional string fields (speechPatterns,
    // clothing, facialFeatures, physicalMannerisms) are absent from the output
    // because the builder uses conditional spread. Array fields with `|| []`
    // fallback (emotions, catchphrases) are always present.
    const story = buildStoryFromEpisodes({
      title: 'A Cold Door',
      genre: 'horror',
      theme: 'dread',
      protagonistName: 'Lira',
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1)),
    });
    const protagonist = story.characters.find((c) => c.role === 'protagonist')!;
    expect(protagonist).toHaveProperty('emotions');
    expect(protagonist).toHaveProperty('catchphrases');
    expect(protagonist).not.toHaveProperty('speechPatterns');
    expect(protagonist).not.toHaveProperty('clothing');
    expect(protagonist).not.toHaveProperty('facialFeatures');
    expect(protagonist).not.toHaveProperty('physicalMannerisms');
  });
});

// REL-018: regression suite for cleanNarration's colon-stripping behavior.
// The previous implementation stripped everything before the first colon in
// any text containing a colon, which caught the canned-mode defaultResponse
// ("Canned response: test mode is active...") and overwrote scene 1 of every
// episode with a 14-word substring. The fix narrows stripping to a known
// label-prefix list.
describe('cleanNarration (REL-018)', () => {
  const realProse =
    'Lira presses her hand to the cold glass and feels the room shift around her.';

  it('passes through plain prose unchanged', () => {
    expect(cleanNarration(realProse, 0)).toBe(realProse);
  });

  it('preserves prose that legitimately contains a colon', () => {
    const withColon =
      'Lira whispers, "Remember: the door only opens for the brave" and steps inside.';
    expect(cleanNarration(withColon, 0)).toBe(withColon);
  });

  it('strips a leading "Scene N:" label', () => {
    const input = 'Scene 3: The wind howls through the broken shutters tonight.';
    expect(cleanNarration(input, 2)).toBe('The wind howls through the broken shutters tonight.');
  });

  it('strips a leading "Episode N:" label', () => {
    const input = 'Episode 1: A small boat drifts across the silver lake.';
    expect(cleanNarration(input, 0)).toBe('A small boat drifts across the silver lake.');
  });

  it('strips a leading "Narration:" label', () => {
    const input = 'Narration: She draws the curtain back with steady hands.';
    expect(cleanNarration(input, 0)).toBe('She draws the curtain back with steady hands.');
  });

  it('strips a leading "Voiceover:" label', () => {
    const input = 'Voiceover: The bells toll across the empty village.';
    expect(cleanNarration(input, 0)).toBe('The bells toll across the empty village.');
  });

  it('does NOT strip a generic colon-prefixed text (REL-018 root case)', () => {
    // This is the exact text that the canned module returns for an
    // unrecognized prompt shape. Before the fix, the first colon was treated
    // as a label delimiter and only the text after it was stored.
    const cannedDefault = 'Canned response: test mode is active and no specific response shape was detected for this prompt.';
    const out = cleanNarration(cannedDefault, 0);
    // The full text must be preserved — the prefix "Canned response:" is not
    // a known label, so the whole string survives.
    expect(out).toBe(cannedDefault);
    // And it must NOT be truncated to the substring after the first colon.
    expect(out.startsWith('Canned response:')).toBe(true);
  });

  it('still parses a JSON wrapper with {hook, scenes}', () => {
    const wrapped = JSON.stringify({
      hook: 'A small boat drifts across the silver lake.',
      scenes: [realProse, realProse, realProse, realProse, realProse],
    });
    expect(cleanNarration(wrapped, 0)).toBe('A small boat drifts across the silver lake.');
  });

  it('falls back to placeholder when the result is too short', () => {
    // "abc" has no known label prefix and is <5 words; placeholder kicks in.
    const out = cleanNarration('abc', 0);
    expect(out.split(/\s+/).length).toBeGreaterThanOrEqual(5);
    expect(out).toMatch(/protagonist/);
  });
});
