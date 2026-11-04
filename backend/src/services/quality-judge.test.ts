/**
 * Tests for L4-QUALITY-LLM — LLM-as-judge quality scoring.
 *
 * The new judge module is the primary quality signal in stage 8. These
 * tests pin the parts of the judge that have a non-trivial local
 * behavior (the digest builder, the grade normalizer, the verdict
 * shape validation). The actual LLM call is mockable through the
 * same `generateWithMistral` indirection used elsewhere; we don't
 * need to mock it here because we're only validating the local
 * surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildJudgeDigest } from './quality-judge.js';
import type { Story } from './types.js';

const FIXED_DATE = '2024-01-01T00:00:00.000Z';

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: 's1', title: 'The Test Story', genre: 'fantasy', theme: 'curiosity',
    status: 'complete', createdAt: FIXED_DATE, updatedAt: FIXED_DATE,
    characters: [
      { id: 'p', name: 'Arlo', description: '', appearance: '', personality: '', role: 'protagonist', gender: 'neutral' },
    ],
    environments: [],
    episodes: [
      { id: 'e1', number: 1, title: 'E1', synopsis: 's1', hook: 'h1', cliffhanger: 'c1', duration: 50,
        scenes: [
          { id: 's1-1', number: 1, duration: 12, narration: { id: 'n1-1', text: 'Opening scene prose.', timing: { totalDuration: 12, wordsPerMinute: 145, charactersPerMinute: 870 }, emotion: 'neutral' }, imagePrompt: { id: 'ip1', type: 'image', content: 'a'.repeat(200), version: 1, createdAt: '' }, videoPrompt: { id: 'vp1', type: 'video', content: 'b'.repeat(200), version: 1, createdAt: '' }, cameraDirection: { type: 'static', movement: 'static', angle: 'medium', lens: 'cinematic' }, emotionalIntensity: 5, transitionType: 'cut', characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' }, environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] } },
          { id: 's1-2', number: 2, duration: 12, narration: { id: 'n1-2', text: 'Second scene prose.', timing: { totalDuration: 12, wordsPerMinute: 145, charactersPerMinute: 870 }, emotion: 'neutral' }, imagePrompt: { id: 'ip2', type: 'image', content: 'a'.repeat(200), version: 1, createdAt: '' }, videoPrompt: { id: 'vp2', type: 'video', content: 'b'.repeat(200), version: 1, createdAt: '' }, cameraDirection: { type: 'static', movement: 'static', angle: 'medium', lens: 'cinematic' }, emotionalIntensity: 5, transitionType: 'cut', characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' }, environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] } },
        ] },
      { id: 'e2', number: 2, title: 'E2', synopsis: 's2', hook: 'h2', cliffhanger: 'c2', duration: 50,
        scenes: [
          { id: 's2-1', number: 1, duration: 12, narration: { id: 'n2-1', text: 'Mid scene prose.', timing: { totalDuration: 12, wordsPerMinute: 145, charactersPerMinute: 870 }, emotion: 'neutral' }, imagePrompt: { id: 'ip3', type: 'image', content: 'a'.repeat(200), version: 1, createdAt: '' }, videoPrompt: { id: 'vp3', type: 'video', content: 'b'.repeat(200), version: 1, createdAt: '' }, cameraDirection: { type: 'static', movement: 'static', angle: 'medium', lens: 'cinematic' }, emotionalIntensity: 5, transitionType: 'cut', characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' }, environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] } },
        ] },
    ],
    metadata: { totalEpisodes: 2, totalScenes: 3, estimatedDuration: 36, targetAudience: 'general', monetizationScore: 80, viralityScore: 80, retentionScore: 80, hookStrength: 80 },
    ...overrides,
  };
}

describe('buildJudgeDigest (L4-QUALITY-LLM)', () => {
  it('includes title, genre, theme, and protagonist name', () => {
    const digest = buildJudgeDigest(makeStory());
    expect(digest).toContain('TITLE: The Test Story');
    expect(digest).toContain('GENRE: fantasy');
    expect(digest).toContain('THEME: curiosity');
    expect(digest).toContain('PROTAGONIST: Arlo');
  });

  it('includes hook, synopsis, cliffhanger for every episode', () => {
    const digest = buildJudgeDigest(makeStory());
    expect(digest).toContain('EP 1 (E1)');
    expect(digest).toContain('hook: h1');
    expect(digest).toContain('synopsis: s1');
    expect(digest).toContain('cliffhanger: c1');
    expect(digest).toContain('EP 2 (E2)');
    expect(digest).toContain('hook: h2');
  });

  it('sorts episodes by number (defends against out-of-order input)', () => {
    const story = makeStory();
    // Reverse episode order
    story.episodes = [story.episodes[1]!, story.episodes[0]!];
    const digest = buildJudgeDigest(story);
    const ep1Idx = digest.indexOf('EP 1 (E1)');
    const ep2Idx = digest.indexOf('EP 2 (E2)');
    expect(ep1Idx).toBeGreaterThan(-1);
    expect(ep2Idx).toBeGreaterThan(ep1Idx);
  });

  it('includes every scene from anchor episodes 1, 5, and 10', () => {
    const longEpisodes = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i + 1}`,
      number: i + 1,
      title: `E${i + 1}`,
      synopsis: `s${i + 1}`,
      hook: `h${i + 1}`,
      cliffhanger: `c${i + 1}`,
      duration: 50,
      scenes: Array.from({ length: 5 }, (_, j) => ({
        id: `sc-${i + 1}-${j + 1}`,
        number: j + 1,
        duration: 12,
        narration: { id: `n-${i + 1}-${j + 1}`, text: `episode-${i + 1}-scene-${j + 1}-text`, timing: { totalDuration: 12, wordsPerMinute: 145, charactersPerMinute: 870 }, emotion: 'neutral' },
        imagePrompt: { id: `ip-${i + 1}-${j + 1}`, type: 'image' as const, content: 'a'.repeat(200), version: 1, createdAt: '' },
        videoPrompt: { id: `vp-${i + 1}-${j + 1}`, type: 'video' as const, content: 'b'.repeat(200), version: 1, createdAt: '' },
        cameraDirection: { type: 'static', movement: 'static', angle: 'medium', lens: 'cinematic' },
        emotionalIntensity: 5,
        transitionType: 'cut',
        characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' },
        environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] },
      })),
    }));
    const story = makeStory({ episodes: longEpisodes as never });
    const digest = buildJudgeDigest(story);
    // Anchor episodes should list all 5 scenes.
    for (const epNum of [1, 5, 10]) {
      for (const sceneNum of [1, 2, 3, 4, 5]) {
        expect(digest).toContain(`episode-${epNum}-scene-${sceneNum}-text`);
      }
    }
    // Non-anchor episodes should include only their first scene.
    expect(digest).toContain('episode-2-scene-1-text');
    expect(digest).not.toContain('episode-2-scene-2-text');
  });

  it('truncates overly long fields to keep the digest small', () => {
    const story = makeStory();
    story.episodes[0]!.hook = 'a'.repeat(5000);
    story.episodes[0]!.synopsis = 'b'.repeat(5000);
    const digest = buildJudgeDigest(story);
    // Each of hook/synopsis should be truncated to ≤ 220 chars + ellipsis
    expect(digest).not.toContain('a'.repeat(500));
    expect(digest).not.toContain('b'.repeat(500));
    // Should end with ellipsis (the truncation marker)
    expect(digest).toContain('…');
  });

  it('keeps the digest under a bounded size even for a maxed-out 10-episode story', () => {
    const longEpisodes = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i + 1}`,
      number: i + 1,
      title: 'T'.repeat(100),
      synopsis: 's'.repeat(5000),
      hook: 'h'.repeat(5000),
      cliffhanger: 'c'.repeat(5000),
      duration: 50,
      scenes: Array.from({ length: 5 }, (_, j) => ({
        id: `sc-${i + 1}-${j + 1}`,
        number: j + 1,
        duration: 12,
        narration: { id: `n-${i + 1}-${j + 1}`, text: 'n'.repeat(5000), timing: { totalDuration: 12, wordsPerMinute: 145, charactersPerMinute: 870 }, emotion: 'neutral' },
        imagePrompt: { id: `ip-${i + 1}-${j + 1}`, type: 'image' as const, content: 'a'.repeat(200), version: 1, createdAt: '' },
        videoPrompt: { id: `vp-${i + 1}-${j + 1}`, type: 'video' as const, content: 'b'.repeat(200), version: 1, createdAt: '' },
        cameraDirection: { type: 'static', movement: 'static', angle: 'medium', lens: 'cinematic' },
        emotionalIntensity: 5,
        transitionType: 'cut',
        characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' },
        environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] },
      })),
    }));
    const story = makeStory({ episodes: longEpisodes as never });
    const digest = buildJudgeDigest(story);
    // 10 episodes × ~680 chars metadata + anchor episodes (3×5×260) + non-anchor scenes (7×260) ≈ 12.5k.
    // We then truncate at 12k in judgeStoryQuality, but the digest itself should be close to the cap.
    expect(digest.length).toBeLessThan(15000);
  });

  it('handles a story with no episodes without throwing', () => {
    const story = makeStory({ episodes: [] });
    expect(() => buildJudgeDigest(story)).not.toThrow();
  });
});

describe('judgeStoryQuality retry resilience (regression: malformed JSON silently fell back to floor score)', () => {
  const validVerdict = JSON.stringify({
    overallScore: 85,
    grade: 'B',
    strength: 'Strong hook',
    issue: '',
    subScores: {
      hook: 80, pacing: 80, characterVoice: 80, visualClarity: 80, plotCoherence: 80,
      emotionalEngagement: 80, sceneUniqueness: 80, conflictEscalation: 80,
      characterConsistency: 80, worldConsistency: 80, originality: 80, endingQuality: 80,
    },
  });

  it('retries with a repair note and recovers from malformed JSON', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../lib/ai-client.js', () => ({
      generateWithMistral: vi.fn(async (_sys: string, user: string) => {
        calls.push(user);
        // First two calls return JSON with an unescaped inner quote (the exact
        // failure seen in production); third call returns valid JSON.
        if (calls.length < 3) return '{"overallScore": 85, "grade": "B", "strength": "The "voice" hooks", }';
        return validVerdict;
      }),
    }));
    const { judgeStoryQuality } = await import('./quality-judge.js');
    const verdict = await judgeStoryQuality(makeStory());
    expect(verdict).not.toBeNull();
    expect(verdict!.overallScore).toBe(85);
    expect(calls.length).toBe(3);
    expect(calls[1]).toContain('REPAIR NOTE');
    expect(calls[2]).toContain('REPAIR NOTE');
    vi.doUnmock('../lib/ai-client.js');
  });

  it('returns null only after all attempts fail', async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock('../lib/ai-client.js', () => ({
      generateWithMistral: vi.fn(async () => {
        calls += 1;
        return '{"overallScore": "not-a-number", broken';
      }),
    }));
    const { judgeStoryQuality } = await import('./quality-judge.js');
    const verdict = await judgeStoryQuality(makeStory());
    expect(verdict).toBeNull();
    expect(calls).toBe(3);
    vi.doUnmock('../lib/ai-client.js');
  });
});
