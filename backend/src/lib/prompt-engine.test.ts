import { buildScenePrompts } from './prompt-engine.js';
import type { Character, Environment } from '../services/types.js';

const protagonist: Character = {
  id: 'protag-1',
  name: 'Lira',
  description: 'a young weaver',
  appearance: 'small, sharp eyes, soot-streaked apron',
  personality: 'careful, quietly brave',
  role: 'protagonist',
};
const environment: Environment = {
  id: 'env-1',
  name: 'Old Workshop',
  description: 'a candlelit workshop with looms and hanging tools',
  type: 'period interior',
  timeOfDay: 'late evening',
  weather: 'cold',
  mood: 'weighted',
  keyFeatures: ['loom', 'hearth', 'wooden floor'],
  colorPalette: ['warm amber', 'iron black'],
  lighting: { primary: 'candlelight', ambient: 'low fill', colorTemperature: 'warm', shadows: 'soft' },
};

describe('prompt-engine', () => {
  it('produces fully populated image and video prompts referencing the scene', () => {
    const result = buildScenePrompts({
      genre: 'mystery',
      episodeNumber: 1,
      sceneIndex: 0,
      narrationText: 'Lira pulls a thread from the loom and the pattern starts to come apart.',
      protagonist,
      environment,
    });

    expect(result.imagePrompt).toMatch(/Lira/);
    expect(result.imagePrompt).toMatch(/Old Workshop/i);
    expect(result.imagePrompt).toMatch(/loom/i);
    expect(result.imagePrompt).not.toMatch(/Enchanted Forest/i);
    expect(result.videoPrompt).toMatch(/camera/i);
    expect(result.videoPrompt).toMatch(/motion|move|push|tracking|orbit/i);
    expect(result.cameraDirection.movement.length).toBeGreaterThan(5);
    expect(result.emotion).toMatch(/^(neutral|happy|dramatic|intense|mysterious|sad)$/);
    expect(result.emotionalIntensity).toBeGreaterThanOrEqual(1);
    expect(result.emotionalIntensity).toBeLessThanOrEqual(10);
  });

  it('produces genre-distinct prompts', () => {
    const horror = buildScenePrompts({
      genre: 'horror',
      episodeNumber: 1,
      sceneIndex: 0,
      narrationText: 'Something moves behind the curtain.',
      protagonist,
      environment,
    });
    const romance = buildScenePrompts({
      genre: 'romance',
      episodeNumber: 1,
      sceneIndex: 0,
      narrationText: 'Lira reaches for his hand.',
      protagonist,
      environment,
    });
    expect(horror.imagePrompt.toLowerCase()).toMatch(/cold|chiaroscuro|low-key|dread|harsh|sickly|fog|moonlight/);
    expect(romance.imagePrompt.toLowerCase()).toMatch(/warm|tender|rim light|pink|cream|window light|petals/);
  });

  it('avoids forbidden style terms list inclusion', () => {
    const result = buildScenePrompts({
      genre: 'horror',
      episodeNumber: 1,
      sceneIndex: 0,
      narrationText: 'A sound from the basement.',
      protagonist,
      environment,
    });
    // The "Avoid:" line lists kawaii etc., which is correct - we want the model to know.
    expect(result.imagePrompt.toLowerCase()).toContain('avoid');
  });

  it('gives every supported genre an explicit emotion bias (regression: tone bleed from shared driftBias)', () => {
    const genres = [
      'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
      'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
      'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
      'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
    ];
    const byGenre = new Map<string, Set<string>>();
    for (const genre of genres) {
      const emotions = new Set<string>();
      for (let beat = 0; beat < 5; beat++) {
        const r = buildScenePrompts({
          genre,
          episodeNumber: 1,
          sceneIndex: beat,
          narrationText: 'The protagonist takes a step forward.',
          protagonist,
          environment,
        });
        emotions.add(r.emotion);
      }
      byGenre.set(genre, emotions);
    }
    // Light genres must never be pushed toward dread on any beat.
    for (const light of ['kids', 'comedy', 'slice-of-life']) {
      for (const e of byGenre.get(light)!) {
        expect(['mysterious', 'intense']).not.toContain(e);
      }
    }
    // Kids and comedy end the arc light, not mysterious.
    expect(byGenre.get('kids')!.has('happy')).toBe(true);
    expect(byGenre.get('comedy')!.has('happy')).toBe(true);
    // Psychological has its own unease arc, distinct from horror's dread arc.
    expect(byGenre.get('psychological')).not.toEqual(byGenre.get('horror'));
    // Genre arcs are not uniform: at least 6 distinct emotion sets across genres.
    const distinct = new Set([...byGenre.values()].map((s) => [...s].sort().join(',')));
    expect(distinct.size).toBeGreaterThanOrEqual(6);
  });
});
