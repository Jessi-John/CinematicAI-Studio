import { describe, it, expect } from 'vitest';
import { safeJsonParse, sanitizeAIResponse } from './sanitize.js';

describe('safeJsonParse repair', () => {
  it('parses clean JSON', () => {
    expect(safeJsonParse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips markdown fences and leading noise', () => {
    expect(safeJsonParse('Sure! ```json\n{"a": 2}\n``` thanks')).toEqual({ a: 2 });
  });

  it('repairs a trailing comma before a closing brace', () => {
    expect(safeJsonParse('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  it('repairs an unterminated string and missing closing brace (truncation)', () => {
    // Model cut off mid-string — the dominant LLM failure mode.
    expect(safeJsonParse('{"title":"The Door","synopsis":"She opens')).toEqual({
      title: 'The Door',
      synopsis: 'She opens',
    });
  });

  it('repairs nested truncation', () => {
    expect(safeJsonParse('{"outer":{"inner":42}')).toEqual({ outer: { inner: 42 } });
  });

  it('repairs a missing final brace after a complete value', () => {
    expect(safeJsonParse('{"a":1,"b":2')).toEqual({ a: 1, b: 2 });
  });

  it('strips markdown asterisks wrapping a value without touching in-string stars', () => {
    expect(safeJsonParse('{"logline": *"When 17-year-old Mira ran"*, "title":"x"}')).toEqual({
      logline: 'When 17-year-old Mira ran',
      title: 'x',
    });
  });

  it('preserves asterisks that are inside a string value', () => {
    expect(safeJsonParse('{"a":"he said *stop* now"}')).toEqual({ a: 'he said *stop* now' });
  });

  it('inserts a missing opening quote on a string value', () => {
    // Observed defect: `"synopsis":    The moment"  (closing quote present,
    // opening quote missing). Value has no internal comma/brace.
    expect(safeJsonParse('{"synopsis": The moment came", "title":"x"}')).toEqual({
      synopsis: 'The moment came',
      title: 'x',
    });
  });

  it('repairs inner quotes inside nested objects and arrays', () => {
    const raw = '{"scenes":[{"text":"She said "run" now"}],"title":"The Door"}';
    expect(safeJsonParse(raw)).toEqual({
      scenes: [{ text: 'She said "run" now' }],
      title: 'The Door',
    });
  });

  it('repairs arrays', () => {
    expect(safeJsonParse('[1,2,')).toEqual([1, 2]);
  });

  it('repairs unescaped quotes inside a string value (the "position N" failure)', () => {
    const raw = '{"synopsis":"She opened the "door" slowly","title":"The Cold Door"}';
    expect(safeJsonParse(raw)).toEqual({
      synopsis: 'She opened the "door" slowly',
      title: 'The Cold Door',
    });
  });

  it('leaves well-formed JSON unchanged', () => {
    expect(safeJsonParse('{"a":"b","n":1}')).toEqual({ a: 'b', n: 1 });
  });

  it('preserves already-escaped inner quotes', () => {
    expect(safeJsonParse('{"a":"he said \\"hi\\""}')).toEqual({ a: 'he said "hi"' });
  });

  it('repairs inner quotes combined with truncation', () => {
    const raw = '{"title":"A "mirror"","synopsis":"It shows a "room"';
    // Embedded quotes that precede more text are escaped; a quote at end-of-input
    // terminates the (truncated) string, which repairJson then closes with `}`.
    expect(safeJsonParse(raw)).toEqual({
      title: 'A "mirror"',
      synopsis: 'It shows a "room',
    });
  });

  it('still throws on content with no JSON at all', () => {
    expect(() => safeJsonParse('this is not json at all')).toThrow();
  });

  it('repairs a value wrapped in markdown asterisks without inner quotes', () => {
    expect(safeJsonParse('{"title": **The Hammer Stops**, "hook":"x"}')).toEqual({
      title: 'The Hammer Stops',
      hook: 'x',
    });
    expect(safeJsonParse('{"hook": *The tooth*, "title":"x"}')).toEqual({
      hook: 'The tooth',
      title: 'x',
    });
  });

  it('still throws on fundamentally malformed JSON', () => {
    expect(() => safeJsonParse('{"a": }')).toThrow();
  });
});

describe('sanitizeAIResponse', () => {
  it('removes think tags and control characters', () => {
    const input = '<think>reasoning</think>{"a":"b\u0001c"}';
    expect(sanitizeAIResponse(input)).toBe('{"a":"bc"}');
  });
});
