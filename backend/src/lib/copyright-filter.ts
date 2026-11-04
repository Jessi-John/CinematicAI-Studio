/**
 * Copyright + monetization filter
 *
 * Normalized + fuzzy one-pass blocklist of trademarks, IP-tied character names,
 * and advertiser-unfriendly content for YouTube monetization compliance.
 * Uses multiple detection strategies:
 * 1. Word-boundary exact match (normalized: lowercase, stripped of non-alphanumerics)
 * 2. Leetspeak normalization (a→4, e→3, i→1, o→0)
 * 3. Fuzzy matching with Levenshtein distance ≤ 2 for high-risk terms
 *
 * If any forbidden term is detected, the field is replaced or the caller is
 * asked to regenerate. Not a substitute for legal review, but stops the
 * obvious failures before they reach YouTube monetization.
 */

// ---------- Normalization utilities ----------

/**
 * Normalize text for comparison: lowercase + strip non-alphanumeric except spaces.
 * "Pikachuu" → "pikachuu", "Pik-achu" → "pikachu", "P1kachu" → "p1kachu"
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

/**
 * Build per-term evasion-tolerant regexes for the check functions. Every
 * letter of the (normalized) term may be followed by any run of NON-
 * alphanumeric characters, so "cocaine" matches "cocaine", "c-o-c-a-i-n-e",
 * "c.o.c.a.i.n.e", and "c o c a i n e". A space inside a multiword term
 * collapses to an OPTIONAL separator run, so "kill myself" also matches
 * "kill-myself" and "killmyself". \b anchors at both ends prevent matching
 * inside longer words ("every" never matches "eve").
 */
function buildCheckRegexes(terms: string[]): Array<{ term: string; re: RegExp }> {
  return terms.map((raw) => {
    const term = normalize(raw);
    const parts = term.split('').map((c) =>
      c === ' ' ? '[^a-z0-9]*' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    return { term: raw, re: new RegExp(`\\b${parts.join('[^a-z0-9]*')}\\b`, 'gi') };
  });
}

/** Find canonical term hits in raw text, honoring negation context. */
function findTermHits(text: string, regexes: Array<{ term: string; re: RegExp }>, negations: ReadonlySet<string>): string[] {
  const hits = new Set<string>();
  for (const { term, re: re0 } of regexes) {
    const re = new RegExp(re0.source, re0.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!isNegatedContext(text, m.index, negations)) hits.add(term.toLowerCase());
    }
  }
  return Array.from(hits);
}

/**
 * Convert leetspeak to normalized form for fuzzy matching.
 * "P1kachu" → "pikachu", "N4rut0" → "naruto"
 */
function normalizeLeet(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 'e')
    .replace(/@/g, 'a')
    .replace(/!/g, 'i')
    .replace(/[^a-z0-9 ]/g, '');
}

/**
 * Levenshtein distance using a single-row buffer (optimal space complexity).
 * Reduces memory from O(mn) to O(min(m,n)) by keeping only the current and
 * previous rows. For comparing a word (len ~5-20) against a short forbidden term
 * (len ~4-15), this uses ~20 integers instead of a 100-300 integer matrix.
 *
 * The trade-off is that we can only get the final distance, not the full
 * backtracking matrix — which is all we need for fuzzy matching.
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure 'a' is the shorter string to minimize buffer size
  if (b.length < a.length) {
    [a, b] = [b, a];
  }

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);

  // Initialize prev row (when b is empty, distance = index)
  for (let j = 0; j <= a.length; j++) prev[j] = j;

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i; // distance from empty a to b[0..i]
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,           // deletion (a[j] deleted)
        curr[j - 1]! + 1,      // insertion (b[i] inserted)
        prev[j - 1]! + cost      // substitution
      );
    }
    // Swap rows: current becomes previous for next iteration
    [prev, curr] = [curr, prev];
  }

  return prev[a.length]!;
}

// ---------- Config loading ----------

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { moduleDir } from './module-path.js';
import { logger } from '../services/logger.js';

interface CopyrightBlocklistConfig {
  forbidden: Array<{ term: string; variants: string[] }>;
  monetization: string[];
  safety: string[];
}

let _cachedConfig: CopyrightBlocklistConfig | null = null;

// M2: Resolve the blocklist path relative to THIS module file (not process.cwd())
// so it works in slim production images that ship only dist/ alongside src/.
// import.meta.url points to this .ts (or compiled .js) file; resolving ../config/
// relative to it finds the JSON regardless of cwd.
// Uses the shared module-path utility for consistent ESM-safe __dirname resolution.
const __moduleDir = moduleDir(import.meta.url);

function resolveBlocklistPath(): string {
  // Try relative to module first (works in slim production images with dist/)
  return resolve(__moduleDir, '..', 'config', 'copyright-blocklist.json');
}

function loadBlocklistConfig(): CopyrightBlocklistConfig {
  if (_cachedConfig) return _cachedConfig;
  // M1: Wrap readFileSync in try/catch so a missing/malformed blocklist file
  // doesn't crash the entire backend process on startup. Previously this was
  // called at module load with no error handling — a missing JSON file would
  // throw a synchronous error that crashes the process.
  const configPath = resolveBlocklistPath();
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    // Try the cwd-relative fallback before giving up
    try {
      raw = readFileSync(resolve(process.cwd(), 'src/config/copyright-blocklist.json'), 'utf8');
    } catch {
      // L6: surface blocklist load failures loudly — the previous path
      // silently disabled ALL THREE filters with zero telemetry, permanently
      // cached. In production this is startup-fatal; in dev/test, degrade.
      if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
        logger.error('Copyright/safety blocklist failed to load — refusing to run filters in fail-open mode');
        throw new Error('copyright-blocklist.json failed to load in production');
      }
      logger.error('Copyright/safety blocklist failed to load — filters DISABLED (dev/test mode)');
      _cachedConfig = { forbidden: [], monetization: [], safety: [] };
      return _cachedConfig;
    }
  }
  try {
    _cachedConfig = JSON.parse(raw) as CopyrightBlocklistConfig;
  } catch {
    _cachedConfig = { forbidden: [], monetization: [], safety: [] };
  }
  return _cachedConfig;
}

// M8: Guard against empty NORMALIZED_TERMS — an empty alternation `()` matches
// empty strings at word boundaries. Only build the regex if there are terms.
function buildNormalizedRegex(terms: string[]): RegExp | null {
  if (terms.length === 0) return null;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
}

/**
 * Build a regex that matches a term even when punctuation/spaces are inserted
 * between its letters ("Pik-achu", "p.i.k.a.c.h.u"). Each letter may be followed
 * by any run of NON-alphanumeric characters, but never another letter — so
 * "every" does not match "eve". Word-anchored at both ends so it cannot match a
 * prefix inside a longer word. A space in the term collapses to a required
 * separator run so "mickey mouse" and "mickey-mouse" both match.
 * Used for redaction so the persisted output actually removes the obfuscated term.
 */
function buildEvasionRegex(term: string): RegExp {
  const parts = term.split('').map((c) =>
    c === ' ' ? '[^a-z0-9]+' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  return new RegExp(`\\b${parts.join('[^a-z0-9]*')}\\b`, 'gi');
}

// ---------- Forbidden terms with variants ----------

const FORBIDDEN_TERMS: Array<{ term: string; variants: string[] }> =
  loadBlocklistConfig().forbidden;


// Build normalized term map for fast lookup
type TermEntry = { original: string; normalized: string; variants: string[] };
const TERM_ENTRIES: TermEntry[] = FORBIDDEN_TERMS.map((entry) => ({
  original: entry.term,
  normalized: normalize(entry.term),
  variants: entry.variants.map((v) => normalizeLeet(v)),
}));

// Exact-match regex (normalized comparison)
const NORMALIZED_TERMS = TERM_ENTRIES.map((e) => e.normalized);
const NORMALIZED_REGEX = buildNormalizedRegex(NORMALIZED_TERMS) ?? /\b(?!a)a\b/gi;

// H4: evasion-tolerant per-variant regexes for checkText's raw-text pass.
// Covers every forbidden term AND all of its declared variants.
const FORBIDDEN_CHECK_REGEXES = buildCheckRegexes(
  FORBIDDEN_TERMS.flatMap((entry) => [entry.term, ...entry.variants])
);

// Build fuzzy lookup: normalized term → original for fuzzy matching
// PERF-010: Only add variants that are genuinely different from the base term
// to avoid fuzzy collisions (e.g., 'thor' in 'thorin' should not match 'thor').
const FUZZY_TERMS: Array<{ normalized: string; original: string }> = [];
TERM_ENTRIES.forEach((entry) => {
  entry.variants.forEach((variant) => {
    // Skip variants that are the same as or too close to the base term
    if (variant === entry.normalized || variant === entry.original) return;
    // Skip short variants (less than 5 chars) to prevent false positives from
    // short forbidden words that could appear as substrings of legitimate content
    if (variant.length < 5) return;
    FUZZY_TERMS.push({ normalized: variant, original: entry.normalized });
  });
});

// ---------- Monetization-blocked terms ----------

const MONETIZATION_BLOCKED_TERMS: string[] = loadBlocklistConfig().monetization;

// H4: evasion-tolerant per-term regexes (see buildCheckRegexes) — the previous
// plain `\bterm\b` regexes ran against RAW text, so trivial punctuation or
// letter-spacing obfuscation ("c-o-c-a-i-n-e", "g o r e") bypassed the gates.
const MONETIZATION_CHECK_REGEXES = buildCheckRegexes(MONETIZATION_BLOCKED_TERMS);

// Hard safety violations (slurs, sexual exploitation, self-harm instructions,
// drug glorification, real-person impersonation). These can never be published
// and therefore ABORT the job, unlike monetization (advertiser-risk) terms which
// are only redacted from the public YouTube listing.
const SAFETY_BLOCKED_TERMS: string[] = loadBlocklistConfig().safety ?? [];

const SAFETY_CHECK_REGEXES = buildCheckRegexes(SAFETY_BLOCKED_TERMS);

// M69: Genre-sensitive safety terms — these are narrative-acceptable in
// horror/dark-fantasy genres (self-harm, drugs are part of the genre's
// thematic vocabulary) but still hard-abort in all other genres. Slurs,
// sexual exploitation, and real-person impersonation always abort regardless
// of genre. For horror, genre-sensitive terms found in narration are
// redacted in-place rather than aborting the entire generation.
const SAFETY_GENRE_SENSITIVE_TERMS = new Set([
  'suicide', 'suicidal', 'self-harm', 'self harm', 'kill myself', 'end my life',
  'cocaine', 'heroin', 'meth', 'methamphetamine', 'crack pipe',
]);
const HARD_SAFETY_CHECK_REGEXES = buildCheckRegexes(
  SAFETY_BLOCKED_TERMS.filter((t) => !SAFETY_GENRE_SENSITIVE_TERMS.has(t))
);

// H4: Negation sets are split per gate. "free" and "forbidden" are NOT true
// negators of harm — "free cocaine" OFFERS cocaine; the broader list stays for
// the monetization gate ("no gore" style prompt instructions) where it was
// designed for, but the hard safety gate only accepts genuine negators.
const NEGATION_WORDS = new Set([
  'no', 'not', 'without', 'non', 'never', 'avoid', 'avoiding',
  'exclude', 'excluding', 'free', 'forbidden',
]);

const SAFETY_NEGATION_WORDS = new Set(['no', 'not', 'without', 'never']);

function isNegatedContext(text: string, matchIndex: number, negations: ReadonlySet<string> = NEGATION_WORDS): boolean {
  const before = text.slice(Math.max(0, matchIndex - 48), matchIndex).toLowerCase();
  const words = before.match(/[a-z]+/g) || [];
  return words.slice(-4).some((w) => negations.has(w));
}

// ---------- Fuzzy matching ----------

/**
 * Extract all words from text for fuzzy comparison.
 * Returns normalized words and their positions.
 */
function extractWords(text: string): Array<{ word: string; index: number; length: number }> {
  const words: Array<{ word: string; index: number; length: number }> = [];
  const regex = /\b[a-z0-9]+\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text.toLowerCase())) !== null) {
    words.push({ word: match[0], index: match.index, length: match[0].length });
  }
  return words;
}

/**
 * Check if text contains any fuzzy match of forbidden terms.
 * Returns the forbidden original term that was matched.
 *
 * Uses Levenshtein distance ≤ 1 (not ≤ 2) to avoid false positives:
 * distance 1 catches genuine leetspeak (p1kachu, pik4chu) while preventing
 * legitimate words (thorin, walked) from falsely matching short terms (thor, walle).
 */
function fuzzyMatch(text: string): string | null {
  const words = extractWords(text);
  for (const { word } of words) {
    for (const { normalized, original } of FUZZY_TERMS) {
      // Direct normalized variant match (leetspeak)
      if (word === normalized) return original;
      // Levenshtein distance ≤ 1 for terms ≥ 5 chars — catches close variants
      // without false positives on longer legitimate words
      if (normalized.length >= 5 && word.length >= 5) {
        const distance = levenshtein(word, normalized);
        if (distance <= 1) return original;
      }
    }
  }
  return null;
}

// ---------- Public API ----------

export interface CopyrightCheckResult {
  clean: boolean;
  hits: string[];
  redacted: string;
}

/**
 * Scan a single string for forbidden terms.
 * Uses word-boundary exact match after normalization, plus fuzzy matching.
 * Returns hits and a redacted version with each hit replaced by "[redacted]".
 */
export function checkText(text: string | null | undefined): CopyrightCheckResult {
  if (!text) return { clean: true, hits: [], redacted: '' };

  // M7: Match the normalized-term regexes against normalize(text), not
  // text.toLowerCase(). toLowerCase() keeps punctuation, so "Pik-achu" never
  // matched the `\bpikachu\b` pattern. normalize() strips non-alphanumerics, so
  // punctuation-obfuscated trademarks ("Pik-achu", "p.i.k.a.c.h.u", "PIKACHU!")
  // collapse to the canonical form and are caught.
  const normalizedText = normalize(text);

  // 1. Exact word-boundary match (normalized)
  const exactMatches = normalizedText.match(NORMALIZED_REGEX) || [];
  // H4: per-variant evasion pass on the raw text so punctuation- or
  // letter-spacing-obfuscated trademarks ("Pik-achu", "p i k a c h u") are
  // caught the same way the safety/monetization gates catch them.
  const evasionMatches = findTermHits(text, FORBIDDEN_CHECK_REGEXES, new Set());
  const exactHits = Array.from(new Set([...exactMatches.map((m) => m.toLowerCase()), ...evasionMatches]));

  // 2. Fuzzy match for leetspeak and close variants
  const fuzzyHits = new Set<string>();
  let fuzzyText = text;
  let fuzzyIterations = 0;
  let match = fuzzyMatch(text);
  while (match) {
    if (++fuzzyIterations > 50) {
      logger.warn({ term: match, limit: 50 }, 'Fuzzy redaction hit iteration cap — some matches may be missed');
      break;
    }
    const wordRegex = /\b[a-z0-9]{3,}\b/gi;
    let found = false;
    let wm: RegExpExecArray | null;
    while ((wm = wordRegex.exec(fuzzyText)) !== null) {
      const w = wm[0];
      const wn = normalizeLeet(w);
      if (wn === normalizeLeet(match) || levenshtein(wn, normalizeLeet(match)) <= 1) {
        fuzzyHits.add(match);
        fuzzyText = fuzzyText.slice(0, wm.index) + '[redacted]' + fuzzyText.slice(wm.index + w.length);
        found = true;
        break;
      }
    }
    if (!found) break;
    match = fuzzyMatch(fuzzyText);
  }

  const allHits = Array.from(new Set([...exactHits, ...Array.from(fuzzyHits)]));

  if (allHits.length === 0) return { clean: true, hits: [], redacted: text };

  // Build redacted version: replace each hit type once (covers most cases)
  let redacted = text;
  for (const hit of allHits) {
    const redaction = '[redacted]';
    // M7: Use an evasion-tolerant pattern so punctuation-obfuscated occurrences
    // ("Pik-achu") are removed from the persisted output, not just the canonical
    // form. A plain `\b<term>\b` would miss the hyphenated variant.
    redacted = redacted.replace(buildEvasionRegex(hit), redaction);
    // Also replace common leetspeak variants
    const leetVariants = FUZZY_TERMS.filter((f) => f.original === hit).map((f) => f.normalized);
    for (const variant of leetVariants) {
      const vBoundary = new RegExp(`\\b${variant}\\b`, 'gi');
      redacted = redacted.replace(vBoundary, redaction);
    }
  }

  return { clean: false, hits: allHits, redacted };
}

/**
 * Scan a structured object's string leaves recursively.
 * Returns the cumulative list of forbidden hits found anywhere.
 */
export function scanObject(input: unknown): string[] {
  const hits = new Set<string>();
  const visited = new Set<object>();
  const visit = (val: unknown) => {
    if (typeof val === 'string') {
      const r = checkText(val);
      r.hits.forEach((h) => hits.add(h));
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (val && typeof val === 'object') {
      if (visited.has(val)) return;
      visited.add(val);
      Object.values(val as Record<string, unknown>).forEach(visit);
    }
  };
  visit(input);
  return Array.from(hits);
}

/**
 * Returns true if any forbidden term is found anywhere in the input.
 */
export function hasCopyrightHit(input: unknown): boolean {
  return scanObject(input).length > 0;
}

// ---------- Monetization checks ----------

export interface MonetizationCheckResult {
  clean: boolean;
  hits: string[];
  redacted: string;
}

/**
 * Scan a single string for monetization-blocked terms.
 */
export function checkMonetization(text: string | null | undefined): MonetizationCheckResult {
  if (!text) return { clean: true, hits: [], redacted: '' };
  // H4: evasion-tolerant matching on the raw text (obfuscation + negation).
  const hitArr = findTermHits(text, MONETIZATION_CHECK_REGEXES, NEGATION_WORDS);
  let redacted = text;
  if (hitArr.length > 0) {
    // Redact evasion-tolerantly so obfuscated occurrences ("g-o-r-e") are
    // removed from the published listing, not just clean forms.
    for (const hit of hitArr) {
      redacted = redacted.replace(buildEvasionRegex(hit), '[redacted]');
    }
  }
  return { clean: hitArr.length === 0, hits: hitArr, redacted };
}

/**
 * Recursively scan any object for monetization-blocked terms.
 */
export function scanObjectForMonetization(input: unknown): string[] {
  const hits = new Set<string>();
  const visited = new Set<object>();
  const visit = (val: unknown): void => {
    if (typeof val === 'string') {
      const r = checkMonetization(val);
      r.hits.forEach((h) => hits.add(h));
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (val && typeof val === 'object') {
      if (visited.has(val)) return;
      visited.add(val);
      Object.values(val as Record<string, unknown>).forEach(visit);
    }
  };
  visit(input);
  return Array.from(hits);
}

/**
 * Returns true if any monetization-blocked term is found anywhere in the input.
 */
export function hasMonetizationHit(input: unknown): boolean {
  return scanObjectForMonetization(input).length > 0;
}

// ---------- Hard safety checks (abort-worthy) ----------

export interface SafetyCheckResult {
  clean: boolean;
  hits: string[];
}

/**
 * Scan a single string for hard safety violations. These are terms that must
 * never be published under any circumstance (slurs, sexual exploitation,
 * self-harm instructions, drug glorification, real-person impersonation).
 */
export function checkSafety(text: string | null | undefined): SafetyCheckResult {
  if (!text) return { clean: true, hits: [] };
  // H4: evasion-tolerant matching on the raw text, with the minimal
  // safety-specific negation set ("free X" is an offer, not a negation).
  const hitArr = findTermHits(text, SAFETY_CHECK_REGEXES, SAFETY_NEGATION_WORDS);
  return { clean: hitArr.length === 0, hits: hitArr };
}

/**
 * Recursively scan any object for hard safety violations.
 */
export function scanObjectForSafety(input: unknown): string[] {
  const hits = new Set<string>();
  const visited = new Set<object>();
  const visit = (val: unknown): void => {
    if (typeof val === 'string') {
      const r = checkSafety(val);
      r.hits.forEach((h) => hits.add(h));
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (val && typeof val === 'object') {
      if (visited.has(val)) return;
      visited.add(val);
      Object.values(val as Record<string, unknown>).forEach(visit);
    }
  };
  visit(input);
  return Array.from(hits);
}

/**
 * M69: Scan for HARD safety violations only (slurs, sexual, real-person
 * impersonation) — excludes genre-sensitive terms (suicide, drugs) that
 * may be narrative-acceptable in horror/dark-fantasy. Used by stage 10
 * to distinguish between "abort always" and "abort or redact by genre."
 */
export function scanObjectForHardSafety(input: unknown): string[] {
  const hits = new Set<string>();
  const visited = new Set<object>();
  const visit = (val: unknown): void => {
    if (typeof val === 'string') {
      const r = findTermHits(val, HARD_SAFETY_CHECK_REGEXES, SAFETY_NEGATION_WORDS);
      r.forEach((h) => hits.add(h));
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (val && typeof val === 'object') {
      if (visited.has(val)) return;
      visited.add(val);
      Object.values(val as Record<string, unknown>).forEach(visit);
    }
  };
  visit(input);
  return Array.from(hits);
}

/**
 * M69: Redact genre-sensitive safety terms from narrative text fields.
 * Returns the list of terms redacted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function redactGenreSensitiveSafetyTerms(story: any): string[] {
  const redacted = new Set<string>();
  // Clone episode data to avoid mutating the original story during scan,
  // then apply redactions to the original.
  const episodes = (story.episodes ?? []) as Array<{
    synopsis?: string | null;
    scenes?: Array<{ narrationText?: string | null }>;
  }>;
  for (const ep of episodes) {
    if (ep.synopsis) {
      for (const term of SAFETY_GENRE_SENSITIVE_TERMS) {
        const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'gi');
        if (regex.test(ep.synopsis)) {
          ep.synopsis = ep.synopsis.replace(regex, '[redacted]');
          redacted.add(term);
        }
      }
    }
    for (const scene of ep.scenes ?? []) {
      if (scene.narrationText) {
        for (const term of SAFETY_GENRE_SENSITIVE_TERMS) {
          const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'gi');
          if (regex.test(scene.narrationText)) {
            scene.narrationText = scene.narrationText.replace(regex, '[redacted]');
            redacted.add(term);
          }
        }
      }
    }
  }
  return Array.from(redacted);
}

/**
 * Returns true if any hard safety violation is found anywhere in the input.
 */
export function hasSafetyHit(input: unknown): boolean {
  return scanObjectForSafety(input).length > 0;
}

/**
 * One-shot policy check: returns combined hits across copyright + safety + monetization.
 */
export function policyHits(input: unknown): { copyright: string[]; safety: string[]; monetization: string[] } {
  return {
    copyright: scanObject(input),
    safety: scanObjectForSafety(input),
    monetization: scanObjectForMonetization(input),
  };
}