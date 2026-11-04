import { describe, it, expect, vi, beforeEach } from 'vitest';

const responses: Array<() => Promise<string>> = [];
vi.mock('./ai-client.js', () => ({
  generateWithMistral: vi.fn().mockImplementation(async () => {
    const next = responses.shift();
    if (!next) throw new Error('No queued LLM response');
    return next();
  }),
}));
vi.mock('../services/generation-logger.js', () => ({
  logFallback: vi.fn().mockResolvedValue(undefined),
  logRetry: vi.fn().mockResolvedValue(undefined),
  logStageComplete: vi.fn().mockResolvedValue(undefined),
}));

import { generateStoryBlueprint } from './episode-generator.js';
import { generateWithMistral } from './ai-client.js';
import { formatGenreDirective } from './genre-directives.js';

const valid = (name: string) =>
  JSON.stringify({
    title: 'The Cold Door',
    protagonistName: name,
    protagonistAge: '16',
    protagonistGender: 'neutral',
    setting: 'Glass Harbor',
    theme: 'trust after loss',
    logline: 'A keeper finds a door that should not open.',
  });

const validFull = (title: string, name: string) =>
  JSON.stringify({
    title,
    protagonistName: name,
    protagonistAge: '16',
    protagonistGender: 'neutral',
    setting: 'Glass Harbor',
    theme: 'trust after loss',
    logline: 'A keeper finds a door that should not open.',
  });

describe('generateStoryBlueprint — no template fallback + name-collision guard', () => {
  beforeEach(() => {
    responses.length = 0;
    vi.mocked(generateWithMistral).mockClear();
  });

  it('throws (does not return hardcoded defaults) when the LLM always fails', async () => {
    responses.push(() => Promise.reject(new Error('LLM down')));
    responses.push(() => Promise.reject(new Error('LLM down')));
    responses.push(() => Promise.reject(new Error('LLM down')));
    await expect(generateStoryBlueprint('fantasy', 'a door')).rejects.toThrow(
      /Blueprint generation failed/
    );
  });

  it('throws when the LLM returns JSON missing required fields', async () => {
    responses.push(() => Promise.resolve('{"title":"x","protagonistName":"y"}'));
    responses.push(() => Promise.resolve('{"title":"x","protagonistName":"y"}'));
    responses.push(() => Promise.resolve('{"title":"x","protagonistName":"y"}'));
    await expect(generateStoryBlueprint('fantasy', 'a door')).rejects.toThrow(
      /Blueprint generation failed/
    );
  });

  it('returns the parsed blueprint when the LLM returns valid JSON', async () => {
    responses.push(() => Promise.resolve(valid('Aelira')));
    const bp = await generateStoryBlueprint('fantasy', 'a door');
    expect(bp.protagonistName).toBe('Aelira');
    expect(bp.title).toBe('The Cold Door');
    expect(bp.theme).toBe('trust after loss');
  });

  it('retries with an exclusion when the proposed protagonist name collides, and returns a different name', async () => {
    responses.push(() => Promise.resolve(valid('Sora'))); // collides with avoidNames
    responses.push(() => Promise.resolve(valid('Aelira'))); // accepted on retry
    const avoid = new Set(['sora']);
    const bp = await generateStoryBlueprint('fantasy', 'a door', [], avoid);
    expect(bp.protagonistName).toBe('Aelira');
    // The prompt must carry the exclusion for "Sora" from the start.
    const firstCallPrompt = vi.mocked(generateWithMistral).mock.calls[0]![1] as string;
    expect(firstCallPrompt).toMatch(/sora/i);
    expect(firstCallPrompt).toMatch(/already taken/i);
  });

  it('collides on the FULL protagonist name, not only the first token', async () => {
    // avoid set contains only the full name "tansy vael" (no bare "tansy"); a
    // first-token-only check would miss it, the full-name check must catch it.
    responses.push(() => Promise.resolve(valid('Tansy Vael')));
    responses.push(() => Promise.resolve(valid('Aelira')));
    const avoid = new Set(['tansy vael']);
    const bp = await generateStoryBlueprint('fantasy', 'a door', [], avoid);
    expect(bp.protagonistName).toBe('Aelira');
    // The exclusion must include the full name, not just the first token.
    const firstCallPrompt = vi.mocked(generateWithMistral).mock.calls[0]![1] as string;
    expect(firstCallPrompt).toMatch(/tansy vael/i);
  });

  it('does NOT collide when only the first name is shared (full-name differs)', async () => {
    // "Tansy Marlowe" is a different protagonist than the catalogued "Tansy Vael";
    // sharing a first name must not block generation.
    responses.push(() => Promise.resolve(valid('Tansy Marlowe')));
    const avoid = new Set(['tansy vael']);
    const bp = await generateStoryBlueprint('fantasy', 'a door', [], avoid);
    expect(bp.protagonistName).toBe('Tansy Marlowe');
    expect(vi.mocked(generateWithMistral).mock.calls.length).toBe(1);
  });

  it('regenerates when the proposed title echoes the seed, and returns a distinct title', async () => {
    responses.push(() => Promise.resolve(validFull('A Cold Door', 'Aelira'))); // title == seed (normalized)
    responses.push(() => Promise.resolve(validFull('The Sealed Threshold', 'Aelira'))); // distinct
    const bp = await generateStoryBlueprint('fantasy', 'a cold door');
    expect(bp.title).toBe('The Sealed Threshold');
    const secondCallPrompt = vi.mocked(generateWithMistral).mock.calls[1]![1] as string;
    expect(secondCallPrompt).toMatch(/title/i);
    expect(secondCallPrompt).toMatch(/seed|distinct/i);
  });

  it('injects the genre directive into the system prompt', async () => {
    responses.push(() => Promise.resolve(valid('Aelira')));
    await generateStoryBlueprint('fantasy', 'a door');
    const systemPrompt = vi.mocked(generateWithMistral).mock.calls[0]![0] as string;
    expect(systemPrompt).toContain(formatGenreDirective('fantasy').slice(0, 80));
    expect(systemPrompt).toContain('GENRE DEFINITION');
  });

  it('injects the genre directive into the user prompt for each target genre', async () => {
    const genres = ['comedy', 'slice-of-life', 'romance', 'drama'] as const;
    for (const genre of genres) {
      responses.push(() => Promise.resolve(valid('Aelira')));
      await generateStoryBlueprint(genre).catch(() => undefined);
      const userPrompt = vi.mocked(generateWithMistral).mock.calls.at(-1)![1] as string;
      const directive = formatGenreDirective(genre);
      expect(userPrompt).toContain(directive.slice(0, 120));
      expect(userPrompt).toContain('GENRE DEFINITION');
    }
  });

  it('explicitly forbids horror for comedy in the injected directive', async () => {
    responses.push(() => Promise.resolve(valid('Riki')));
    await generateStoryBlueprint('comedy');
    const userPrompt = vi.mocked(generateWithMistral).mock.calls[0]![1] as string;
    expect(userPrompt.toLowerCase()).toContain('comedy:');
    expect(userPrompt.toLowerCase()).toContain('forbidden elements');
    expect(userPrompt.toLowerCase()).toContain('horror');
    expect(userPrompt.toLowerCase()).toContain('dread');
  });

  it('explicitly forbids supernatural for slice-of-life in the injected directive', async () => {
    responses.push(() => Promise.resolve(valid('Mio')));
    await generateStoryBlueprint('slice-of-life');
    const userPrompt = vi.mocked(generateWithMistral).mock.calls[0]![1] as string;
    expect(userPrompt.toLowerCase()).toContain('slice-of-life');
    expect(userPrompt.toLowerCase()).toContain('supernatural');
    expect(userPrompt.toLowerCase()).toContain('ghosts');
    expect(userPrompt.toLowerCase()).toContain('mundane');
  });

  it('requires a romantic connection for romance in the injected directive', async () => {
    responses.push(() =>
      Promise.resolve(
        JSON.stringify({
          title: 'The Voice in Static',
          protagonistName: 'Mira',
          protagonistAge: '18',
          protagonistGender: 'neutral',
          setting: 'A coastal radio tower',
          theme: 'A love story about two strangers who connect over a shared radio frequency.',
          logline: 'A lonely engineer falls for a voice on the radio.',
        })
      )
    );
    await generateStoryBlueprint('romance');
    const userPrompt = vi.mocked(generateWithMistral).mock.calls[0]![1] as string;
    expect(userPrompt.toLowerCase()).toContain('romance:');
    expect(userPrompt.toLowerCase()).toContain('romantic connection');
    expect(userPrompt.toLowerCase()).toContain('love interest');
  });

  it('rejects off-genre comedy with a phantom and retries with a corrective note', async () => {
    responses.push(() =>
      Promise.resolve(
        validFull('The Cafeteria Phantom', 'Riki')
      )
    );
    responses.push(() =>
      Promise.resolve(
        validFull('The Talent Show Disaster', 'Riki')
      )
    );
    const bp = await generateStoryBlueprint('comedy');
    expect(bp.title).toBe('The Talent Show Disaster');
    const secondCallPrompt = vi.mocked(generateWithMistral).mock.calls[1]![1] as string;
    expect(secondCallPrompt).toMatch(/STRICT GENRE CORRECTION/i);
    expect(secondCallPrompt.toLowerCase()).toContain('phantom');
    expect(secondCallPrompt.toLowerCase()).toContain('forbidden');
  });

  it('rejects off-genre slice-of-life with magic and retries', async () => {
    responses.push(() =>
      Promise.resolve(
        JSON.stringify({
          title: 'The Lantern That Would Not Die',
          protagonistName: 'Mio',
          protagonistAge: '16',
          protagonistGender: 'neutral',
          setting: 'A quiet neighborhood shop',
          theme: 'A shopkeeper discovers a magical lantern that casts impossible colors.',
          logline: 'A supernatural light leads to a hidden alley.',
        })
      )
    );
    responses.push(() => Promise.resolve(valid('Mio')));
    const bp = await generateStoryBlueprint('slice-of-life');
    expect(bp.protagonistName).toBe('Mio');
    const secondCallPrompt = vi.mocked(generateWithMistral).mock.calls[1]![1] as string;
    expect(secondCallPrompt).toMatch(/STRICT GENRE CORRECTION/i);
    expect(secondCallPrompt.toLowerCase()).toContain('magic');
  });

  it('rejects off-genre drama with an impossible door and retries', async () => {
    responses.push(() =>
      Promise.resolve(
        JSON.stringify({
          title: 'The Door That Was Not There',
          protagonistName: 'Haruo',
          protagonistAge: '17',
          protagonistGender: 'neutral',
          setting: 'A neglected apartment building',
          theme: 'A tenant finds a door that opens to a staircase of impossible light.',
          logline: 'An impossible door reveals a family secret.',
        })
      )
    );
    responses.push(() => Promise.resolve(valid('Haruo')));
    const bp = await generateStoryBlueprint('drama');
    expect(bp.protagonistName).toBe('Haruo');
    const secondCallPrompt = vi.mocked(generateWithMistral).mock.calls[1]![1] as string;
    expect(secondCallPrompt).toMatch(/STRICT GENRE CORRECTION/i);
    expect(secondCallPrompt.toLowerCase()).toContain('impossible');
  });

  it('rejects romance without a relationship signal and retries', async () => {
    responses.push(() =>
      Promise.resolve(
        JSON.stringify({
          title: 'The Vanishing Frequency',
          protagonistName: 'Mira',
          protagonistAge: '18',
          protagonistGender: 'neutral',
          setting: 'A coastal radio tower',
          theme: 'A coder tracks a mysterious signal that predicts disasters.',
          logline: 'A protagonist uncovers a signal that should not exist.',
        })
      )
    );
    responses.push(() =>
      Promise.resolve(
        JSON.stringify({
          title: 'The Voice in Static',
          protagonistName: 'Mira',
          protagonistAge: '18',
          protagonistGender: 'neutral',
          setting: 'A coastal radio tower',
          theme: 'A love story about two strangers who connect over a shared radio frequency.',
          logline: 'A lonely engineer falls for a voice on the radio.',
        })
      )
    );
    const bp = await generateStoryBlueprint('romance');
    expect(bp.title).toBe('The Voice in Static');
    const secondCallPrompt = vi.mocked(generateWithMistral).mock.calls[1]![1] as string;
    expect(secondCallPrompt).toMatch(/STRICT GENRE CORRECTION/i);
    expect(secondCallPrompt.toLowerCase()).toContain('love');
  });
});
