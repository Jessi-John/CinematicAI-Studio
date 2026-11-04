import {
  normalizeForTTS,
  buildVoiceoverText,
  stripStageLabels,
} from './tts-normalize.js';

describe('TTS Normalization', () => {
  it('expands common abbreviations', () => {
    expect(normalizeForTTS('Mr. Lira and Dr. Hale walked.')).toContain('Mister Lira');
    expect(normalizeForTTS('Mr. Lira and Dr. Hale walked.')).toContain('Doctor Hale');
  });

  it('converts numbers to words', () => {
    expect(normalizeForTTS('She climbed 12 steps')).toBe('She climbed twelve steps');
    expect(normalizeForTTS('1,000 lanterns lit the path')).toBe(
      'one thousand lanterns lit the path'
    );
  });

  it('normalizes smart punctuation', () => {
    expect(normalizeForTTS('“hello” — said she…')).not.toContain('“');
    expect(normalizeForTTS('“hello” — said she…')).not.toContain('—');
    expect(normalizeForTTS('“hello” — said she…')).not.toContain('…');
  });

  it('strips stage-direction labels', () => {
    const text = '[HOOK] something stirs. [Scene 1 - mysterious] she opened the door.';
    const stripped = stripStageLabels(text);
    expect(stripped).not.toContain('[HOOK]');
    expect(stripped).not.toContain('[Scene');
    expect(stripped).toContain('she opened the door');
  });

  it('is idempotent on already-clean text', () => {
    const clean = 'She walked across the field.';
    expect(normalizeForTTS(normalizeForTTS(clean))).toBe(normalizeForTTS(clean));
  });

  it('builds a clean voiceoverText with terminal punctuation per part', () => {
    const out = buildVoiceoverText({
      hook: 'Something stirs',
      scenes: ['She opens the door', 'Wind howls'],
      cliffhanger: 'A name is whispered',
    });
    expect(out).toMatch(/Something stirs\./);
    expect(out).toMatch(/She opens the door\./);
    expect(out).toMatch(/A name is whispered\./);
    expect(out).not.toContain('[');
  });

  it('does not double-add terminal punctuation', () => {
    const out = buildVoiceoverText({
      hook: 'Something stirs.',
      scenes: ['She opens the door!'],
      cliffhanger: 'Who is there?',
    });
    expect(out).not.toMatch(/\.\./);
    expect(out).not.toMatch(/!\./);
    expect(out).not.toMatch(/\?\./);
  });

  it('handles empty input gracefully', () => {
    expect(normalizeForTTS('')).toBe('');
    expect(buildVoiceoverText({ hook: '', scenes: [], cliffhanger: '' })).toBe('');
  });
});
