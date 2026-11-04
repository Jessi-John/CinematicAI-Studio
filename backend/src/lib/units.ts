/**
 * Branded numeric types for units of time.
 *
 * Using branded types prevents the class of bugs where a value in minutes is
 * accidentally passed where seconds are expected (or vice versa). The brand
 * is a phantom type — it exists only at compile time and has zero runtime cost.
 *
 * Usage:
 *   import { seconds, minutes, toMs, type Seconds, type Milliseconds } from './units.js';
 *
 *   function waitFor(duration: Seconds): Promise<void> { ... }
 *   waitFor(seconds(30));            // ✅ explicit conversion
 *   waitFor(minutes(30) as Seconds); // ❌ type error at compile time
 *
 * Conversion functions DOUBLE as runtime identity (they cast at compile time
 * and return the same number at runtime), so there is no overhead.
 *
 */

export type Brand<T, B extends string> = T & { __brand: B };
export type Seconds = Brand<number, 'seconds'>;
export type Milliseconds = Brand<number, 'milliseconds'>;
export type Minutes = Brand<number, 'minutes'>;

export function isFinitePositive(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function seconds(n: number): Seconds {
  if (!isFinitePositive(n)) {
    if (typeof n !== 'number') n = NaN;
    return (Number.isFinite(n) ? Math.max(0, n) : 0) as Seconds;
  }
  return n as Seconds;
}

export function milliseconds(n: number): Milliseconds {
  if (!isFinitePositive(n)) {
    if (typeof n !== 'number') n = NaN;
    return (Number.isFinite(n) ? Math.max(0, n) : 0) as Milliseconds;
  }
  return n as Milliseconds;
}

export function minutes(n: number): Minutes {
  if (!isFinitePositive(n)) {
    if (typeof n !== 'number') n = NaN;
    return (Number.isFinite(n) ? Math.max(0, n) : 0) as Minutes;
  }
  return n as Minutes;
}

/** Convert seconds to milliseconds. */
export function toMs(d: Seconds): Milliseconds {
  return (d * 1000) as Milliseconds;
}

/** Convert minutes to seconds. */
export function toSeconds(m: Minutes): Seconds {
  return (m * 60) as Seconds;
}

/** Convert milliseconds to seconds. */
export function secFromMs(ms: Milliseconds): Seconds {
  return (ms / 1000) as Seconds;
}

/** Convert words-per-minute to seconds for a given word count. */
export function wpmToSeconds(wordCount: number, wpm: number): Seconds {
  // L22: guard division by zero / negative — previously returned Infinity.
  if (wpm <= 0) return 0 as Seconds;
  return (wordCount * 60 / wpm) as Seconds;
}
