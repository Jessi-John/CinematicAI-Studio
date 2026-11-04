/**
 * TTS Normalization
 *
 * Converts narration prose into a form a TTS engine can read aloud directly:
 *   - numbers → words ("12" → "twelve", "1,000" → "one thousand")
 *   - common abbreviations expanded ("Mr." → "Mister")
 *   - smart quotes / em-dashes / ellipses normalized
 *   - bracketed stage directions stripped
 *   - whitespace collapsed
 *
 * Pure functions, no I/O. Keep deterministic so unit tests can pin behaviour.
 */

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Misses'],
  [/\bMs\./g, 'Miss'],
  [/\bDr\./g, 'Doctor'],
  [/\bSt\./g, 'Saint'],
  [/\bJr\./g, 'Junior'],
  [/\bSr\./g, 'Senior'],
  [/\bvs\./gi, 'versus'],
  [/\betc\./gi, 'et cetera'],
  [/\bi\.e\./gi, 'that is'],
  [/\be\.g\./gi, 'for example'],
];

// Stage-direction labels from voiceoverScript / scene headers we never want
// a TTS to read aloud, e.g. "[HOOK]", "[Scene 3 - mysterious]".
const LABEL_PATTERN = /\[\s*(HOOK|CLIFFHANGER|Scene[^\]]*)\s*\]\s*/gi;

const SMART_PUNCT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u2013\u2014\u2015]/g, ', '], // en/em dashes → comma+space
  [/\u2026/g, '...'],
];

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function intToWords(n: number): string {
  if (n < 0) return 'negative ' + intToWords(-n);
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return TENS[t]! + (o > 0 ? '-' + ONES[o]! : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return ONES[h] + ' hundred' + (r > 0 ? ' ' + intToWords(r) : '');
  }
  if (n < 1_000_000) {
    const k = Math.floor(n / 1000);
    const r = n % 1000;
    return intToWords(k) + ' thousand' + (r > 0 ? ' ' + intToWords(r) : '');
  }
  if (n < 1_000_000_000) {
    const m = Math.floor(n / 1_000_000);
    const r = n % 1_000_000;
    return intToWords(m) + ' million' + (r > 0 ? ' ' + intToWords(r) : '');
  }
  // Beyond a billion: keep as digits rather than guessing.
  return String(n);
}

function numberTokenToWords(token: string): string {
  // Strip commas in numeric formatters: 1,000 → 1000.
  const stripped = token.replace(/(?<=\d),(?=\d)/g, '');
  if (/^\d+$/.test(stripped)) {
    const n = Number(stripped);
    if (Number.isFinite(n) && Math.abs(n) < 1_000_000_000) return intToWords(n);
  }
  return token;
}

/**
 * Strip stage-direction brackets like [HOOK], [Scene 1 - mysterious].
 */
export function stripStageLabels(text: string): string {
  return text.replace(LABEL_PATTERN, '');
}

/**
 * Produce a TTS-ready version of the input. Idempotent.
 */
export function normalizeForTTS(text: string): string {
  if (!text) return '';

  let out = stripStageLabels(text);

  for (const [re, rep] of SMART_PUNCT_REPLACEMENTS) out = out.replace(re, rep);
  for (const [re, rep] of ABBREVIATIONS) out = out.replace(re, rep);

  // Convert standalone whole numbers (with optional thousand-separators) to words.
  out = out.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m) => numberTokenToWords(m));

  // Collapse runs of whitespace and trim.
  out = out.replace(/[ \t]+/g, ' ').replace(/\s+\n/g, '\n').trim();

  return out;
}

/**
 * Build a fully clean voiceover transcript for an episode:
 *   <hook>. <scene1>. <scene2>. ... <scene5>. <cliffhanger>.
 * No labels, no brackets, ready to feed to a TTS endpoint.
 */
export function buildVoiceoverText(input: {
  hook: string;
  scenes: string[];
  cliffhanger: string;
}): string {
  const parts = [input.hook, ...input.scenes, input.cliffhanger]
    .map((p) => normalizeForTTS(p))
    .filter((p) => p.length > 0)
    .map((p) => (/[.!?]$/.test(p) ? p : p + '.'));
  return parts.join(' ');
}
