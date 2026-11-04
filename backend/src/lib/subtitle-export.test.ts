import {
  episodeToSSML,
  storyToSSML,
  episodeToSRT,
  episodeToVTT,
  storyToSRT,
  storyToVTT,
  episodeToVoiceoverScript,
} from './subtitle-export.js';
import type { Story, Episode } from '../services/types.js';

function buildEpisode(num: number): Episode {
  return {
    id: `ep-${num}`,
    number: num,
    title: `Episode ${num}`,
    synopsis: 'syn',
    hook: 'hook line',
    cliffhanger: 'cliff line',
    duration: 50,
    scenes: Array.from({ length: 5 }, (_, i) => ({
      id: `s-${num}-${i + 1}`,
      number: i + 1,
      duration: 10,
      narration: {
        id: `n-${num}-${i + 1}`,
        // Use prose that won't be mutated by the TTS normalizer (no digits, no
        // smart punctuation). Each scene line stays unique via the loop index.
        text: `Scene narration line ${['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i]}.`,
        timing: { totalDuration: 10, wordsPerMinute: 145, charactersPerMinute: 870 },
        emotion: 'neutral' as const,
      },
      imagePrompt: { id: 'i', type: 'image' as const, content: 'img', version: 1, createdAt: '' },
      videoPrompt: { id: 'v', type: 'video' as const, content: 'vid', version: 1, createdAt: '' },
      cameraDirection: { type: 'static' as const, movement: 'static', angle: 'medium', lens: 'cinematic' },
      emotionalIntensity: 5,
      transitionType: 'cut' as const,
      characterState: { characterId: '', position: 'center', action: 'still', emotion: 'neutral', expression: 'calm', bodyLanguage: 'natural' },
      environmentState: { environmentId: '', timeOfDay: 'day', weather: 'clear', lighting: 'natural', atmosphere: 'calm', ambientSounds: [] },
    })),
  };
}

const story: Story = {
  id: 'st-1',
  title: 'Test',
  genre: 'fantasy',
  status: 'complete',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  episodes: [buildEpisode(1), buildEpisode(2)],
  characters: [],
  environments: [],
  metadata: {
    totalEpisodes: 2,
    totalScenes: 10,
    estimatedDuration: 100,
    targetAudience: '',
    monetizationScore: 0,
    viralityScore: 0,
    retentionScore: 0,
    hookStrength: 0,
  },
};

describe('subtitle-export', () => {
  it('emits valid SSML root', () => {
    const ssml = storyToSSML(story);
    expect(ssml).toMatch(/^<\?xml/);
    expect(ssml).toMatch(/<speak/);
    expect(ssml).toMatch(/<\/speak>/);
  });

  it('emits SRT with monotonic increasing timestamps', () => {
    const srt = episodeToSRT(buildEpisode(1));
    const lines = srt.split('\n').filter((l) => l.includes('-->'));
    expect(lines.length).toBe(5);
    expect(lines[0]).toMatch(/00:00:00,000 --> 00:00:10,000/);
    expect(lines[1]).toMatch(/00:00:10,000 --> 00:00:20,000/);
    expect(lines[4]).toMatch(/00:00:40,000 --> 00:00:50,000/);
  });

  it('emits WebVTT with header', () => {
    const vtt = episodeToVTT(buildEpisode(1));
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    // WebVTT uses optional hours (MM:SS.mmm when h=0) — match that pattern
    expect(vtt).toMatch(/00:10\.000/);
  });

  it('full-story SRT continues offsets across episodes', () => {
    const srt = storyToSRT(story);
    expect(srt).toMatch(/00:00:50,000 --> 00:01:00,000/); // first scene of ep 2 starts at 00:00:50
    expect(srt).toMatch(/00:01:30,000 --> 00:01:40,000/); // last scene of ep 2 ends at 01:40
  });

  it('full-story VTT contains both episodes', () => {
    const vtt = storyToVTT(story);
    expect(vtt).toMatch(/Episode 1/);
    expect(vtt).toMatch(/Episode 2/);
  });

  it('voiceover script labels HOOK and CLIFFHANGER', () => {
    const script = episodeToVoiceoverScript(buildEpisode(1));
    expect(script).toMatch(/\[HOOK\]/);
    expect(script).toMatch(/\[CLIFFHANGER\]/);
    expect(script).toMatch(/\[Scene 1/);
    expect(script).toMatch(/\[Scene 5/);
  });

  it('episode SSML contains hook, all scenes, cliffhanger', () => {
    const ssml = episodeToSSML(buildEpisode(1));
    expect(ssml).toMatch(/hook line/);
    expect(ssml).toMatch(/alpha/);
    expect(ssml).toMatch(/epsilon/);
    expect(ssml).toMatch(/cliff line/);
  });

  it('SSML output is TTS-normalized: no stage labels, no smart-quote glyphs', () => {
    const ep = buildEpisode(1);
    // Inject something the normalizer should clean up.
    ep.scenes[0]!.narration.text = '[Scene 1 - tense] She had 12 hours left — barely enough.';
    const ssml = episodeToSSML(ep);
    expect(ssml).not.toMatch(/\[Scene/);
    expect(ssml).not.toContain('—');
    // 12 should be expanded to "twelve".
    expect(ssml).toMatch(/twelve/);
  });

  // ---------- UNIT-SAFETY INVARIANTS ----------
  // These tests ensure that the branded-unit types in subtitle-export.ts
  // produce correct timestamps. They are invariant tests — the assertions
  // must hold regardless of input shape.

  describe('unit-safety invariants', () => {
    it('INVARIANT: WPM→seconds conversion yields timestamps proportional to word count', () => {
      // A scene with 145 words at 145 WPM should produce exactly 60 seconds.
      // This validates the conversion formula (wordCount * 60 / wpm).
      const ep = buildEpisode(1);
      ep.scenes[0]!.duration = undefined as unknown as number;
      ep.scenes[0]!.narration.timing.totalDuration = undefined as unknown as number;
      const words = Array.from({ length: 145 }, (_, i) => `word${i}`);
      ep.scenes[0]!.narration.text = words.join(' ');
      const srt = episodeToSRT(ep);
      // First cue end should be ~60s (145 words at 145 WPM = 60s)
      expect(srt).toMatch(/00:01:00,000/);
    });

    it('INVARIANT: monotonic increasing timestamps never go backwards', () => {
      const ep = buildEpisode(1);
      const srt = episodeToSRT(ep);
      const matches = [...srt.matchAll(/\d{2}:\d{2}:\d{2},\d{3}/g)];
      const timestamps = matches.map((m) => {
        const [h, mns, s, ms] = m[0].split(/[:,]/).map(Number);
        return h! * 3600000 + mns! * 60000 + s! * 1000 + ms!;
      });
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!);
      }
    });

    it('INVARIANT: total duration equals sum of individual scene durations', () => {
      const ep = buildEpisode(1);
      const srt = episodeToSRT(ep);
      const matches = [...srt.matchAll(/\d{2}:\d{2}:\d{2},\d{3}/g)];
      const timestamps = matches.map((m) => {
        const [h, mns, s, ms] = m[0].split(/[:,]/).map(Number);
        return h! * 3600000 + mns! * 60000 + s! * 1000 + ms!;
      });
      // Total duration = last end - first start
      const totalMs = timestamps[timestamps.length - 1]! - timestamps[0]!;
      // Each scene is 10s, 5 scenes = 50s = 50000ms
      expect(totalMs).toBe(50000);
    });

    it('INVARIANT: cross-episode offsets do not overlap', () => {
      // Two episodes of 5 scenes each, scene duration=10s, ep duration=50s
      // Episode 2 cue 1 should start at 00:00:50,000 (end of episode 1)
      const srt = storyToSRT(story);
      expect(srt).toMatch(/00:00:50,000 --> 00:01:00,000/);
      const allEnds = [...srt.matchAll(/00:00:50,000 --> 00:01:00,000/g)];
      expect(allEnds.length).toBeGreaterThanOrEqual(1);
    });
  });
});
