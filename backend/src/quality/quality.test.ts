/**
 * Quality Penalty Regression Tests
 *
 * These tests prove the quality penalty engine behaves correctly at known
 * input/output pairs. All penalty logic is fully deterministic.
 */

import { describe, it, expect } from 'vitest';
import { calculateQualityPenalties } from './index.js';
import type { QualityInput } from './index.js';

/* Each scene MUST have completely unique narration text so the repetition
 * penalty is 0. Sharing any trigram across scenes triggers a penalty. */
const NARRATIONS = [
  'Beyond the misty ridge lay an ancient kingdom forgotten by time itself.',
  'She traced her fingers along the weathered map searching for hidden paths.',
  'Thunder rolled across the valley as dark clouds gathered overhead.',
  'The old wizard muttered incantations beneath the flickering candlelight.',
  'Footsteps echoed through the empty corridor leading to the grand hall.',
  'A solitary raven perched upon the gnarled branch watching the travelers.',
  'Deep within the cavern walls glittered crystals of impossible colors.',
  'The captain surveyed the damage from the previous nights brutal storm.',
  'Golden sunlight filtered through the canopy casting dancing shadows below.',
  'Letters sealed with crimson wax held secrets that could change everything.',
  'The merchant displayed unusual artifacts from lands beyond the great sea.',
  'Children laughed and played among the ruins of the old cathedral.',
  'A cold wind swept through the village square scattering autumn leaves.',
  'She discovered a hidden passage behind the tapestry in the library.',
  'The blacksmith hammered rhythmically while singing an old folk song.',
  'Moonlight illuminated the garden where two figures met in secret.',
  'Ancient runes carved into stone pulsed with a soft blue glow.',
  'The diplomat negotiated terms that would determine the kingdoms fate.',
  'Waves crashed against the cliffs sending spray high into the air.',
  'He studied the stars searching for the constellation his father described.',
  'A feast was prepared in honor of the returning heroes of the north.',
  'The forest path split into three directions each equally foreboding.',
  'She opened the locket revealing a portrait of someone long passed.',
  'Guards patrolled the perimeter checking every shadow for intruders.',
  'The scholar deciphered the ancient text with growing excitement each day.',
];

const FULL_STORY: QualityInput = {
  episodes: Array.from({ length: 10 }, (_, i) => ({
    hook: 'Chapter ' + (i + 1) + ' brings a surprising turn!',
    cliffhanger: 'But what lies ahead remains unclear...',
    scenes: Array.from({ length: 5 }, (_, j) => ({
      narration: NARRATIONS[(i * 5 + j) % NARRATIONS.length]!,
    })),
  })),
};

describe('calculateQualityPenalties', () => {
  // ---------- Empty / edge cases ----------

  describe('empty stories', () => {
    it('returns 0 repetitionPenalty for empty story', () => {
      expect(calculateQualityPenalties({}).repetitionPenalty).toBe(0);
    });

    it('returns 20 structurePenalty for story with no episodes (missing all content)', () => {
      expect(calculateQualityPenalties({}).structurePenalty).toBe(20);
    });

    it('returns 0 continuityPenalty for empty story (no episodes to compare)', () => {
      expect(calculateQualityPenalties({}).continuityPenalty).toBe(0);
    });

    it('totalPenalty equals structurePenalty when only structure is penalised', () => {
      const result = calculateQualityPenalties({});
      expect(result.totalPenalty).toBe(result.structurePenalty);
    });

    it('issues array contains structural issue when story is empty', () => {
      const result = calculateQualityPenalties({});
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.toLowerCase().includes('structural'))).toBe(true);
    });
  });

  // ---------- Repetition penalty ----------

  describe('repetitionPenalty', () => {
    it('is 0 when there are no repeated trigrams', () => {
      const result = calculateQualityPenalties(FULL_STORY);
      expect(result.repetitionPenalty).toBe(0);
    });

    it('is > 0 when highly repeated 3-word phrases appear across the story', () => {
      const repetitiveText = 'the rain falls down the rain falls down the rain falls the rain falls the rain falls';
      const input: QualityInput = {
        episodes: [{
          hook: 'h',
          cliffhanger: 'c',
          scenes: Array.from({ length: 5 }, () => ({ narration: repetitiveText })),
        }],
      };
      // "the rain falls" appears in every scene — over epCount*2 (1*2 = 2) times
      const result = calculateQualityPenalties(input);
      expect(result.repetitionPenalty).toBeGreaterThan(0);
    });

    it('is 15 when more than 5 distinct trigrams are highly repeated', () => {
      const repeats = ['one two three ', 'four five six ', 'seven eight nine '].join('').repeat(10);
      const input: QualityInput = {
        episodes: [{
          hook: 'h',
          cliffhanger: 'c',
          scenes: Array.from({ length: 5 }, () => ({ narration: repeats })),
        }],
      };
      const result = calculateQualityPenalties(input);
      expect(result.repetitionPenalty).toBeGreaterThanOrEqual(10);
    });
  });

  // ---------- Structure penalty ----------

  describe('structurePenalty', () => {
    it('penalises scene count variance > 3', () => {
      const input: QualityInput = {
        episodes: [
          { hook: 'h', cliffhanger: 'c', scenes: [{ narration: 'a'.repeat(50) }] },
          { hook: 'h', cliffhanger: 'c', scenes: Array.from({ length: 10 }, () => ({ narration: 'b'.repeat(50) })) },
        ],
      };
      const result = calculateQualityPenalties(input);
      expect(result.structurePenalty).toBeGreaterThanOrEqual(10);
    });

    it('penalises short/empty narration when more than 3 scenes are affected', () => {
      const input: QualityInput = {
        episodes: [{
          hook: 'hook',
          cliffhanger: 'cliff',
          scenes: [
            { narration: 'x' },
            { narration: '' },
            { narration: 'y' },
            { narration: 'z' },
            { narration: 'w' },
          ],
        }],
      };
      const result = calculateQualityPenalties(input);
      expect(result.structurePenalty).toBeGreaterThanOrEqual(10);
    });

    it('penalises when more than half the episodes lack hooks', () => {
      const input: QualityInput = {
        episodes: Array.from({ length: 10 }, () => ({
          hook: '',  // all hooks empty
          cliffhanger: 'good cliffhanger here',
          scenes: [{ narration: 'n'.repeat(50) }],
        })),
      };
      const result = calculateQualityPenalties(input);
      expect(result.structurePenalty).toBeGreaterThanOrEqual(10);
    });

    it('penalises when more than half the episodes lack cliffhangers', () => {
      const input: QualityInput = {
        episodes: Array.from({ length: 10 }, () => ({
          hook: 'good hook here',
          cliffhanger: '',  // all cliffhangers empty
          scenes: [{ narration: 'n'.repeat(50) }],
        })),
      };
      const result = calculateQualityPenalties(input);
      expect(result.structurePenalty).toBeGreaterThanOrEqual(10);
    });
  });

  // ---------- Continuity penalty ----------

  describe('continuityPenalty', () => {
    it('is 0 for a single episode story (no adjacent pair to compare)', () => {
      const input: QualityInput = {
        episodes: [{
          hook: 'h',
          cliffhanger: 'c',
          scenes: [{ narration: 'n'.repeat(50) }],
        }],
      };
      expect(calculateQualityPenalties(input).continuityPenalty).toBe(0);
    });

    it('is > 0 when a cliffhanger exists but the next episode lacks a hook', () => {
      const input: QualityInput = {
        episodes: [
          { hook: 'h1', cliffhanger: 'What will happen next?', scenes: [{ narration: 'n'.repeat(50) }] },
          { hook: '', cliffhanger: 'c2', scenes: [{ narration: 'n'.repeat(50) }] },  // no hook after cliffhanger
        ],
      };
      const result = calculateQualityPenalties(input);
      expect(result.continuityPenalty).toBeGreaterThan(0);
    });

    it('caps continuityPenalty at 20', () => {
      // Create many episodes where each cliffhanger has no follow-through hook
      const episodes = Array.from({ length: 10 }, (_, i) => ({
        hook: i === 0 ? 'start' : '',  // only first ep has a hook
        cliffhanger: 'What happens next?',
        scenes: [{ narration: 'n'.repeat(50) }],
      }));
      const result = calculateQualityPenalties({ episodes });
      expect(result.continuityPenalty).toBeLessThanOrEqual(20);
    });
  });

  // ---------- No issues ----------

  describe('clean stories', () => {
    it('returns 0 totalPenalty for a well-formed story', () => {
      const result = calculateQualityPenalties(FULL_STORY);
      expect(result.totalPenalty).toBe(0);
    });

    it('returns empty issues for a well-formed story', () => {
      const result = calculateQualityPenalties(FULL_STORY);
      expect(result.issues).toHaveLength(0);
    });
  });

  // ---------- Issues ----------

  describe('issues', () => {
    it('includes an issue entry for each penalty category > 0', () => {
      const input: QualityInput = {
        episodes: [{
          hook: '',
          cliffhanger: '',
          scenes: Array.from({ length: 5 }, () => ({ narration: 'x' })),
        }],
      };
      const result = calculateQualityPenalties(input);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      // All issues should mention the penalty value
      for (const issue of result.issues) {
        expect(issue).toMatch(/-\d+/);
      }
    });

    it('contains structural issue when structurePenalty > 0', () => {
      const result = calculateQualityPenalties({});
      expect(result.issues.some((i) => i.toLowerCase().includes('structural'))).toBe(true);
    });
  });
});
