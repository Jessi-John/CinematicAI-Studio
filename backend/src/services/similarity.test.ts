/**
 * Unit tests for the similarity detection service.
 * Tests normalizeForSimilarity, calcTextSimilarity in isolation.
 * Integration tests for findDuplicateConcept are in e2e/story-worker.integration.spec.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeForSimilarity, calcTextSimilarity, checkSeoTitleDuplicate } from './similarity.js';
import { DuplicateSeoTitleError } from '../database/prisma-storage/validation.js';
import { prisma } from '../database/prisma.js';

vi.mock('../database/prisma.js', () => {
  const queryMock = vi.fn();
  const client = { $queryRaw: queryMock };
  return { prisma: () => client };
});

beforeEach(() => {
  vi.mocked(prisma().$queryRaw).mockClear();
});

describe('normalizeForSimilarity', () => {
  it('should lowercase text', () => {
    expect(normalizeForSimilarity('HELLO WORLD')).toEqual(['hello', 'world']);
  });

  it('should remove punctuation', () => {
    expect(normalizeForSimilarity('hello, world!')).toEqual(['hello', 'world']);
  });

  it('should filter stop words', () => {
    const result = normalizeForSimilarity('the quick brown fox jumps over the lazy dog');
    // Stop words are: the, and, for, with, that, this, from, into, story, episode, journey, style, anime, short
    // "over" is NOT a stop word in this implementation
    expect(result).not.toContain('the');
    expect(result).not.toContain('story');
    expect(result).toContain('quick');
    expect(result).toContain('brown');
    expect(result).toContain('fox');
    expect(result).toContain('jumps');
    expect(result).toContain('over'); // "over" is not in STOP_WORDS
    expect(result).toContain('lazy');
    expect(result).toContain('dog');
  });

  it('should filter tokens with 2 or fewer characters', () => {
    const result = normalizeForSimilarity('a b c cat dog');
    expect(result).toEqual(['cat', 'dog']);
  });

  it('should split on whitespace', () => {
    expect(normalizeForSimilarity('one two three')).toEqual(['one', 'two', 'three']);
  });

  it('should return empty array for empty string', () => {
    expect(normalizeForSimilarity('')).toEqual([]);
  });

  it('should return empty array when all tokens are stop words or short', () => {
    expect(normalizeForSimilarity('the a an')).toEqual([]);
  });
});

describe('calcTextSimilarity', () => {
  it('should return 1 for identical text', () => {
    expect(calcTextSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('should return 0 for completely different text', () => {
    const sim = calcTextSimilarity('cat dog bird fish', 'apple banana cherry date');
    expect(sim).toBe(0);
  });

  it('should return 0 for empty strings', () => {
    expect(calcTextSimilarity('', '')).toBe(0);
    expect(calcTextSimilarity('hello', '')).toBe(0);
    expect(calcTextSimilarity('', 'world')).toBe(0);
  });

  it('should return moderate score for partial overlap', () => {
    const sim = calcTextSimilarity('the quick brown fox', 'the lazy brown dog');
    // Intersection: {the, brown} = 2; Union: 8; Jaccard = 2/8 = 0.25
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('should be symmetric', () => {
    const a = 'hello world foo bar';
    const b = 'world foo baz qux';
    expect(calcTextSimilarity(a, b)).toBe(calcTextSimilarity(b, a));
  });
});

describe('LIVE-5: checkSeoTitleDuplicate', () => {
  it('returns quietly when no similar title exists', async () => {
    vi.mocked(prisma().$queryRaw).mockResolvedValue([]);
    await expect(checkSeoTitleDuplicate('Unique Title')).resolves.toBeUndefined();
  });

  it('throws DuplicateSeoTitleError when a similar title exists', async () => {
    vi.mocked(prisma().$queryRaw).mockResolvedValue([
      { title: 'The Hidden Ink That BREATHES (Fantasy Anime Story #1)', sim: 0.92 },
    ]);
    await expect(
      checkSeoTitleDuplicate('The Hidden Ink That BREATHES (Horror Anime Story #1)')
    ).rejects.toThrow(DuplicateSeoTitleError);
  });

  it('excludes the story being replaced', async () => {
    vi.mocked(prisma().$queryRaw).mockResolvedValue([]);
    await expect(checkSeoTitleDuplicate('Same Title', 'old-story-id')).resolves.toBeUndefined();
    const lastCall = vi.mocked(prisma().$queryRaw).mock.calls.at(-1) as unknown[];
    const containsId = (lastCall || []).some((arg) =>
      arg !== null &&
      typeof arg === 'object' &&
      'values' in arg &&
      Array.isArray((arg as { values: unknown[] }).values) &&
      (arg as { values: unknown[] }).values.includes('old-story-id')
    );
    expect(containsId).toBe(true);
  });
});