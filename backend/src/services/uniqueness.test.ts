/**
 * Uniqueness Service Tests – generateUniqueStoryPrompt
 *
 * We test the pure functions in isolation.
 * analyzeExistingStories requires a working prisma connection or mock;
 * generateUniqueStoryPrompt is pure and needs no DB.
 */

import { describe, it, expect } from 'vitest';
import { generateUniqueStoryPrompt } from './uniqueness.js';
import type { Genre } from './types.js';

describe('generateUniqueStoryPrompt', () => {
  const emptyAnalysis = {
    usedCharacterNames: new Set<string>(),
    usedCharacterFullNames: new Set<string>(),
    usedEnvironmentNames: new Set<string>(),
    usedTitleWords: new Set<string>(),
    usedHooks: new Set<string>(),
    usedCliffhangers: new Set<string>(),
    genreThemes: new Map<Genre, string[]>(),
  };

  it('returns a theme when analysis is empty and no preferred seed', () => {
    const result = generateUniqueStoryPrompt('fantasy', emptyAnalysis);
    // The theme is a non-empty string (a default fantasy prompt).
    expect(result.theme.length).toBeGreaterThan(0);
    expect(Array.isArray(result.constraints)).toBe(true);
  });

  it('uses preferredSeed as theme when provided', () => {
    const result = generateUniqueStoryPrompt('fantasy', emptyAnalysis, 'My Custom Seed');
    expect(result.theme).toBe('My Custom Seed');
  });

  it('adds character name constraints up to 10 items', () => {
    const analysis = {
      ...emptyAnalysis,
      usedCharacterNames: new Set([
        'sora', 'lira', 'kael', 'nix', 'oren', 'sage', 'fox', 'ember', 'ash', 'zara', 'ria', 'noa',
      ]),
    };
    const result = generateUniqueStoryPrompt('fantasy', analysis);
    const charConstraint = result.constraints.find(c => c.includes('Avoid character name'));
    // Pin the constraint to a real string. The result of `find` is
    // string | undefined; pin it to the string form so a missing
    // constraint is caught at the index-access site, not just by a
    // truthy check that would pass for any non-null value.
    expect(typeof charConstraint).toBe('string');
    const namesInConstraint = charConstraint!
      .replace('Avoid character name patterns: ', '')
      .split(', ');
    expect(namesInConstraint.length).toBeLessThanOrEqual(10);
  });

  it('adds environment name constraints', () => {
    const analysis = {
      ...emptyAnalysis,
      usedEnvironmentNames: new Set([
        'Misty Valley', 'Crystal Lake', 'Iron Keep', 'Shadow Moor', 'Golden Dunes',
      ]),
    };
    const result = generateUniqueStoryPrompt('fantasy', analysis);
    const envConstraint = result.constraints.find(c => c.includes('Avoid environment names'));
    expect(typeof envConstraint).toBe('string');
    expect(envConstraint!.length).toBeGreaterThan(0);
  });

  it('adds title word constraints', () => {
    const analysis = {
      ...emptyAnalysis,
      usedTitleWords: new Set([
        'ember', 'crown', 'shadow', 'light', 'dark', 'frost', 'flame', 'storm', 'wind', 'water',
        'stone', 'iron', 'gold', 'silver', 'crystal',
      ]),
    };
    const result = generateUniqueStoryPrompt('fantasy', analysis);
    const titleConstraint = result.constraints.find(c => c.includes('Avoid title words'));
    expect(typeof titleConstraint).toBe('string');
    expect(titleConstraint!.length).toBeGreaterThan(0);
  });

  it('skips unused themes for the given genre', () => {
    const analysis: typeof emptyAnalysis = {
      ...emptyAnalysis,
      genreThemes: new Map<Genre, string[]>([
        ['fantasy', ['ancient prophecy awakening', 'forgotten magic returning']],
      ]),
    };
    const result = generateUniqueStoryPrompt('fantasy', analysis);
    // The function must always return a non-empty theme string.
    expect(result.theme.length).toBeGreaterThan(0);
  });

  it('returns empty constraints when analysis is empty', () => {
    const result = generateUniqueStoryPrompt('fantasy', emptyAnalysis);
    expect(result.constraints).toEqual([]);
  });
});
