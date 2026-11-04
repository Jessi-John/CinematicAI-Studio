/**
 * Tests for ai-client.canned.ts — the test-mode bypass for the AI provider API.
 *
 * These tests verify that the canned responses:
 *   - Match the shape expected by each pipeline stage
 *   - Pass downstream validation (scene word count 22-28, embedding dim 1024, etc.)
 *   - Are deterministic for the same input
 *   - Vary across calls so the pipeline produces distinct episodes/scenes
 */
import { describe, test, expect, afterEach } from 'vitest';
import { cannedChatResponse, cannedEmbedding, isCannedMode } from './ai-client.canned.js';

describe('ai-client.canned', () => {
  const original = process.env.STORY_TEST_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.STORY_TEST_MODE;
    else process.env.STORY_TEST_MODE = original;
  });

  describe('isCannedMode', () => {
    test('returns true only when STORY_TEST_MODE=canned', () => {
      delete process.env.STORY_TEST_MODE;
      expect(isCannedMode()).toBe(false);
      process.env.STORY_TEST_MODE = 'canned';
      expect(isCannedMode()).toBe(true);
      process.env.STORY_TEST_MODE = 'live';
      expect(isCannedMode()).toBe(false);
    });
  });

  describe('cannedChatResponse — blueprint', () => {
    test('returns JSON with required blueprint fields', () => {
      const r = cannedChatResponse(
        'You are a master storyteller generating a story blueprint.',
        'Generate blueprint: title, protagonist, setting, theme, logline.'
      );
      const parsed = JSON.parse(r);
      expect(typeof parsed.title).toBe('string');
      expect(parsed.title.length).toBeGreaterThan(0);
      expect(typeof parsed.protagonistName).toBe('string');
      expect(typeof parsed.setting).toBe('string');
      expect(typeof parsed.theme).toBe('string');
      expect(typeof parsed.logline).toBe('string');
    });

    // REL-012: Regression for canned-mode misdetection. The blueprint system
    // prompt mentions "YouTube Shorts" generically, which the OLD detector
    // matched first as 'seo' shape. The result was stories with title
    // "Secret Canned Story" (from seoResponse) and the canned blueprint
    // JSON was never returned. Detection must use user-prompt JSON templates.
    test('REL-012: detects blueprint from logline/protagonistName JSON template even when system prompt mentions "youtube"', () => {
      const realBlueprintSystem =
        'You are a creative story architect specializing in original cinematic anime story content for YouTube Shorts. YOUTUBE MONETIZATION RULES...';
      const realBlueprintUser =
        'Create a story based on this seed: "A young mage". Genre: fantasy. Return ONLY this JSON: { "title": "...", "protagonistName": "...", "protagonistAge": "...", "setting": "...", "theme": "...", "logline": "..." }';
      const r = cannedChatResponse(realBlueprintSystem, realBlueprintUser);
      const parsed = JSON.parse(r);
      // Blueprint fields must be present (not seo fields)
      expect(parsed).toHaveProperty('protagonistName');
      expect(parsed).toHaveProperty('logline');
      // Should NOT have seo-only fields
      expect(parsed).not.toHaveProperty('hookScript');
      expect(parsed).not.toHaveProperty('viralPotential');
    });
  });

  describe('cannedChatResponse — scene', () => {
    test('returns narration with 22-28 words', () => {
      const r = cannedChatResponse(
        'You generate narrative scene prose.',
        'Episode 1. The narrator speaks for 22-28 words on a new scene.'
      );
      const words = r.trim().split(/\s+/);
      expect(words.length).toBeGreaterThanOrEqual(22);
      expect(words.length).toBeLessThanOrEqual(28);
    });

    test('different episodes produce different scenes', () => {
      const sys = 'You generate narrative scene prose.';
      const ep1 = cannedChatResponse(sys, 'Episode 1, narrator speaks.');
      const ep2 = cannedChatResponse(sys, 'Episode 2, narrator speaks.');
      const ep3 = cannedChatResponse(sys, 'Episode 3, narrator speaks.');
      const unique = new Set([ep1, ep2, ep3]);
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  describe('cannedChatResponse — episode meta', () => {
    test('returns JSON with title/hook/synopsis/cliffhanger', () => {
      const r = cannedChatResponse(
        'You generate episode meta.',
        'Return JSON: title, hook, synopsis, cliffhanger, episodeSummary.'
      );
      const parsed = JSON.parse(r);
      expect(typeof parsed.title).toBe('string');
      expect(typeof parsed.hook).toBe('string');
      expect(typeof parsed.synopsis).toBe('string');
      expect(typeof parsed.cliffhanger).toBe('string');
    });
  });

  describe('cannedChatResponse — SEO', () => {
    test('returns SEO with title/description/tags', () => {
      const r = cannedChatResponse(
        'You are a YouTube growth expert.',
        'Optimize story for YouTube.'
      );
      const parsed = JSON.parse(r);
      expect(parsed.title.length).toBeLessThanOrEqual(60);
      // BL-004: title must contain power/emotion word or number
      const tl = parsed.title.toLowerCase();
      const hasPowerOrEmotion = /secret|hidden|untold|shocking|revealed|forbidden|mysterious|lost|cursed|awakened|heartwarming|tearjerking|thrilling|heartbreaking|breathtaking|emotional|intense|dark|hopeful|desperate|\d/.test(tl);
      expect(hasPowerOrEmotion).toBe(true);
      expect(Array.isArray(parsed.tags)).toBe(true);
    });
  });

  describe('cannedChatResponse — title-unique', () => {
    test('returns valid JSON title object for title-uniqueness retry prompts', () => {
      const r = cannedChatResponse(
        'You are an editor enforcing strict title-uniqueness rules. Output JSON only.',
        'Your previous title "Echoes in the Grove" is not allowed. Reply with ONLY a single valid JSON object: {"title": "<new unique title>"}'
      );
      const parsed = JSON.parse(r);
      expect(typeof parsed.title).toBe('string');
      expect(parsed.title.length).toBeGreaterThan(0);
    });
  });

  describe('cannedChatResponse — similarity', () => {
    test('returns similarity scores for given ids', () => {
      const r = cannedChatResponse(
        'You score similarity.',
        'IDs: ["a","b","c"]. Score these.'
      );
      const parsed = JSON.parse(r);
      expect(Array.isArray(parsed.similarityScores)).toBe(true);
      expect(parsed.similarityScores.length).toBe(3);
      for (const s of parsed.similarityScores) {
        expect(typeof s.id).toBe('string');
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('cannedEmbedding', () => {
    test('returns 1024-dim vector', () => {
      const v = cannedEmbedding('hello world');
      expect(v.length).toBe(1024);
    });

    test('is deterministic for same input', () => {
      const a = cannedEmbedding('hello world');
      const b = cannedEmbedding('hello world');
      expect(a).toEqual(b);
    });

    test('differs for different inputs', () => {
      const a = cannedEmbedding('hello world');
      const b = cannedEmbedding('goodbye sky');
      expect(a).not.toEqual(b);
    });

    test('vector is L2-normalized (magnitude ≈ 1)', () => {
      const v = cannedEmbedding('a sample text for normalization');
      let sumSq = 0;
      for (const x of v) sumSq += x * x;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1, 5);
    });
  });
});
