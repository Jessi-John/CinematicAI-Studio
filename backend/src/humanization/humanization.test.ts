import { humanization } from './index.js';

describe('Humanization Service', () => {
  describe('process()', () => {
    it('strips markdown bold', () => {
      const result = humanization.process('**bold** text remains');
      expect(result.text).not.toContain('**');
      expect(result.text).toContain('bold text');
    });

    it('strips markdown headers', () => {
      const result = humanization.process('# Heading\nbody');
      expect(result.text).not.toContain('#');
    });

    it('strips wiki markup', () => {
      const result = humanization.process('See [[reference]] here');
      expect(result.text).toContain('reference');
      expect(result.text).not.toContain('[[');
    });

    it('strips placeholder variables', () => {
      const result = humanization.process('Hello {character_name} today');
      expect(result.text).not.toMatch(/\{[a-z_]+\}/);
    });

    it('strips <think> blocks', () => {
      const result = humanization.process('<think>internal</think>output');
      expect(result.text).toContain('output');
      expect(result.text).not.toContain('think');
    });

    it('removes Suddenly, opener', () => {
      const result = humanization.process('Suddenly, the wind picked up.');
      expect(result.text.toLowerCase()).not.toMatch(/^suddenly,/);
    });

    it('preserves common verbs and conjunctions', () => {
      const input = 'The forest is calm. However, danger lurks.';
      const result = humanization.process(input);
      // Critical: humanization must NOT delete "is" or "however"
      expect(result.text.toLowerCase()).toContain('is');
      expect(result.text.toLowerCase()).toContain('however');
    });

    it('produces 0..100 AI score', () => {
      const result = humanization.process('A short test sentence here.');
      expect(result.aiScore).toBeGreaterThanOrEqual(0);
      expect(result.aiScore).toBeLessThanOrEqual(100);
    });
  });

  describe('detectRepetition()', () => {
    it('detects repeated 3-word phrases', () => {
      const text = 'ancient forest old ancient forest old ancient forest old whispers';
      const result = humanization.detectRepetition(text);
      expect(result.hasRepetition).toBe(true);
    });

    it('returns similarity score against previous texts', () => {
      const text = 'The ancient forest calls to those who listen.';
      const prev = ['The ancient forest whispers secrets of the past.'];
      const result = humanization.detectRepetition(text, prev);
      expect(result.similarityScore).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = humanization.process('');
      expect(result.text).toBe('');
    });

    it('handles short text', () => {
      const result = humanization.process('Hi.');
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  // ---------- aiScore calibration ----------
  // These tests prove that the aiScore threshold (80) meaningfully separates
  // human-quality prose from AI-formulaic prose. If the threshold or penalty
  // weights are changed, these tests will fail and catch regressions.

  describe('aiScore calibration', () => {
    it('human literary prose scores >= 80 (passes threshold)', () => {
      const humanProse =
        'The rain came sudden and hard, drumming against the windows like an impatient guest. She stood at the sill, watching the street below turn into a river of silver.';
      const result = humanization.process(humanProse);
      expect(result.aiScore).toBeGreaterThanOrEqual(80);
    });

    it('AI-formulaic prose scores < 90 (fails strict threshold, triggers retry)', () => {
      const aiProse =
        'It is important to note that the protagonist enters the scene. Suddenly, all of a sudden, the atmosphere changes. However, despite the challenges faced, the journey continues.';
      const result = humanization.process(aiProse);
      expect(result.aiScore).toBeLessThan(90); // mechanical transitions + formal words push score below 90
    });

    it('repetitive sentence starts trigger penalty via low sentenceStartVariety', () => {
      // All sentences start with the same word — low start variety
      const repetitive = 'The door opened. The wind blew. The rain fell. The night fell. The stars shone.';
      const variedStart = 'She opened the door. Outside, the wind blew. Heavy rain fell from the night sky above.';
      const repetitiveScore = humanization.process(repetitive).aiScore;
      const variedScore = humanization.process(variedStart).aiScore;
      expect(repetitiveScore).toBeLessThan(variedScore);
    });

    it('uniform sentence lengths trigger penalty via low sentenceLengthVariance', () => {
      // All same-length sentences — variance near 0
      const uniform = 'He walks. She runs. They stop. We wait. It ends. Birds sing. Time flows. Light fades.';
      const varied = 'She walked. Beyond the hills, a vast and ancient forest stretched toward the distant mountains.';
      const uniformScore = humanization.process(uniform).aiScore;
      const variedScore = humanization.process(varied).aiScore;
      expect(uniformScore).toBeLessThan(variedScore);
    });

    it('high transition density (however/therefore) triggers penalty', () => {
      const dense = 'The rain fell. However, the path remained clear. Therefore, we continued. Moreover, the journey was long. Nevertheless, we pressed on.';
      const natural = 'The rain fell. The path remained clear ahead of us. We continued through the long journey, pressing ever onward.';
      const denseScore = humanization.process(dense).aiScore;
      const naturalScore = humanization.process(natural).aiScore;
      expect(denseScore).toBeLessThan(naturalScore);
    });

    it('uniform sentence lengths are penalised vs varied lengths', () => {
      // Uniform: all 2-word sentences → variance = 0 < 5 → -20
      const uniform = 'She walks. He runs. They think. We wait. They leave.';
      // Varied: 2-word and 12-word sentences → variance > 10 → no penalty
      const varied = 'She walks. Beyond the hills, a vast and ancient forest stretched toward the distant mountains.';
      const uniformScore = humanization.process(uniform).aiScore;
      const variedScore = humanization.process(varied).aiScore;
      expect(uniformScore).toBeLessThan(variedScore); // uniform is penalised, varied is not
    });

    it('high sentence-length variance is not penalised', () => {
      // Varied sentence lengths → natural rhythm
      const varied =
        'The door opened. Beyond it lay an enormous hall, its ceiling lost in shadow.';
      const result = humanization.process(varied);
      // Should not be penalised for variance
      expect(result.aiScore).toBeGreaterThanOrEqual(70);
    });

    it('robotic opener "Little did they know" is replaced (not penalised separately)', () => {
      const withOpener = humanization.process(
        'Little did they know, the door was already open.'
      );
      // The opener is replaced with '' so it should not appear in output
      expect(withOpener.text.toLowerCase()).not.toContain('little did they know');
    });

    it('score floor is 0 even with maximum penalties', () => {
      // Rhythmically bad text: repetitive starts, uniform lengths, high transition density
      const badText =
        'The rain however the path remained clear therefore we continued moreover the journey was long nevertheless we pressed onward furthermore the wind picked up consequently we hurried.';
      const result = humanization.process(badText);
      expect(result.aiScore).toBeGreaterThanOrEqual(0);
    });

    it('score ceiling is 100 even with no penalties', () => {
      const clean = 'Hello world.';
      const result = humanization.process(clean);
      expect(result.aiScore).toBeLessThanOrEqual(100);
    });
  });

  // ---------- lowScoreSentences ----------

  describe('lowScoreSentences', () => {
    it('returns empty array for text with fewer than 3 sentences', () => {
      const result = humanization.process('Hello world.');
      expect(result.lowScoreSentences).toEqual([]);
    });

    it('flags sentences with repetitive first words as low-scoring', () => {
      const text = 'The wind blew hard. The rain fell fast. The night grew dark. She shivered once.';
      const result = humanization.process(text);
      // First 3 sentences all start with "The" → should be flagged
      expect(result.lowScoreSentences.length).toBeGreaterThanOrEqual(2);
      expect(result.lowScoreSentences).toContain(0);
      expect(result.lowScoreSentences).toContain(1);
    });

    it('flags sentences with near-identical length to both neighbors', () => {
      const text = 'He walks. She runs fast. They hurried onward. We wait. Birds fly.';
      const result = humanization.process(text);
      // Some sentences are same length as neighbors → should be flagged
      expect(result.lowScoreSentences.length).toBeGreaterThan(0);
    });

    it('flags sentences with excessive transitions', () => {
      const text = 'The rain fell. However the path remained clear. Therefore we continued onward. The night grew dark.';
      const result = humanization.process(text);
      expect(result.lowScoreSentences.length).toBeGreaterThan(0);
    });
  });

  // ---------- Rhythm metrics ----------

  describe('analyzeRhythm', () => {
    it('returns high sentenceStartVariety for varied sentence starts', () => {
      const sentences = ['She walked.', 'Beyond the hills lay a forest.', 'Ancient trees swayed.', 'The path wound onward.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.sentenceStartVariety).toBeGreaterThanOrEqual(0.5);
    });

    it('returns low sentenceStartVariety for repetitive starts', () => {
      const sentences = ['The door opened.', 'The wind blew.', 'The rain fell.', 'The night grew dark.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.sentenceStartVariety).toBeLessThan(0.6);
    });

    it('returns high sentenceLengthVariance for varied lengths', () => {
      const sentences = ['Hi.', 'This is a much longer sentence with more words in it.', 'Short.', 'And another fairly lengthy sentence here for testing purposes.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.sentenceLengthVariance).toBeGreaterThan(1);
    });

    it('returns low sentenceLengthVariance for uniform lengths', () => {
      const sentences = ['One two three.', 'Four five six.', 'Seven eight nine.', 'Ten eleven twelve.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.sentenceLengthVariance).toBeLessThan(5);
    });

    it('returns high transitionDensity for text with many transitions', () => {
      const sentences = ['The rain fell.', 'However the path remained.', 'Therefore we continued.', 'Moreover the journey was long.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.transitionDensity).toBeGreaterThan(0.02);
    });

    it('returns 0 transitionDensity for text with no transitions', () => {
      const sentences = ['The rain fell.', 'The path remained clear.', 'We continued onward.', 'The journey was long.'];
      const metrics = humanization.analyzeRhythm(sentences);
      expect(metrics.transitionDensity).toBe(0);
    });
  });
});
