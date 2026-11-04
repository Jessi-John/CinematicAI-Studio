import {
  checkText,
  scanObject,
  hasCopyrightHit,
  checkMonetization,
  scanObjectForMonetization,
  checkSafety,
  scanObjectForSafety,
  policyHits,
} from './copyright-filter.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Copyright filter', () => {
  it('flags a known IP term', () => {
    const r = checkText('A young hero named Pikachu sets out');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('pikachu');
    expect(r.redacted).toContain('[redacted]');
  });

  it('passes clean text', () => {
    const r = checkText('A young hero named Sora sets out into the misty hills');
    expect(r.clean).toBe(true);
    expect(r.hits.length).toBe(0);
  });

  it('respects word boundaries', () => {
    const r = checkText('the warrior thorin walked');
    expect(r.clean).toBe(true);
  });

  // M7: punctuation-obfuscation evasion
  it('flags a hyphen-obfuscated trademark ("Pik-achu")', () => {
    const r = checkText('A young hero named Pik-achu sets out');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('pikachu');
  });

  it('redacts the hyphen-obfuscated trademark from the persisted output', () => {
    const r = checkText('A young hero named Pik-achu sets out');
    expect(r.redacted).not.toContain('Pik-achu');
    expect(r.redacted).toContain('[redacted]');
  });

  it('flags a dot-obfuscated trademark ("p.i.k.a.c.h.u")', () => {
    const r = checkText('meet p.i.k.a.c.h.u today');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('pikachu');
  });

  it('flags a trademark with trailing punctuation ("PIKACHU!")', () => {
    const r = checkText('PIKACHU! returns');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('pikachu');
  });

  it('does not over-redact a word that merely starts with a blocked term', () => {
    // "thorin" must stay intact even though "thor" is blocked — word-anchored
    // evasion regex must not match a prefix inside a longer word.
    const r = checkText('the mighty thor fought and thorin watched');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('thor');
    expect(r.redacted).toContain('thorin');
    expect(r.redacted).not.toContain('mighty thor fought');
  });


  it('scans nested objects', () => {
    const story = {
      title: 'Spirited Away part two',
      characters: [{ name: 'Sora' }, { name: 'Totoro' }],
    };
    const hits = scanObject(story);
    expect(hits.length).toBeGreaterThan(0);
    expect(hasCopyrightHit(story)).toBe(true);
  });
});

describe('Monetization filter', () => {
  it('flags graphic violence', () => {
    const r = checkMonetization('She decapitated the bandit.');
    expect(r.clean).toBe(false);
    expect(r.hits.some((h) => h.includes('decapit'))).toBe(true);
  });

  it('flags slurs', () => {
    // slurs are a hard safety violation, not advertiser-risk monetization
    const r = checkSafety('She called him a faggot');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('faggot');
  });

  it('flags self-harm', () => {
    // self-harm is a hard safety violation, not advertiser-risk monetization
    const r = checkSafety('She thought about suicide that night.');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('suicide');
  });

  it('flags sexual content', () => {
    const r = checkMonetization('They had sex behind the door.');
    expect(r.clean).toBe(false);
  });

  it('passes clean prose', () => {
    const r = checkMonetization('She walked through the forest carrying a lantern.');
    expect(r.clean).toBe(true);
  });

  it('scans nested objects', () => {
    const story = {
      title: 'A Calm Morning',
      scenes: [{ text: 'A peaceful walk through the woods.' }, { text: 'Cocaine was passed around.' }],
    };
    // cocaine is a hard safety violation, not an advertiser-risk (monetization) term
    expect(scanObjectForSafety(story)).toContain('cocaine');
    expect(scanObjectForMonetization(story)).not.toContain('cocaine');
  });

  it('respects word boundaries (does not flag innocent substrings)', () => {
    // "scope" must not match the substring within other terms incorrectly
    const r = checkMonetization('She held a scope and looked through it.');
    expect(r.clean).toBe(true);
  });

  it('does not flag negated terms such as "no gore"', () => {
    const r = checkMonetization('painterly anime horror, sharp linework, no gore');
    expect(r.clean).toBe(true);
  });

  it('does not flag terms inside an avoid-list instruction', () => {
    const r = checkMonetization('avoid horror, gore, cyberpunk in the image prompt');
    expect(r.clean).toBe(true);
  });

  it('still flags genuine blocked content with negation words elsewhere', () => {
    const r = checkMonetization('The scene depicted graphic gore across the walls.');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('gore');
  });
});

describe('policyHits', () => {
  it('returns separate copyright, safety and monetization hit lists', () => {
    const result = policyHits({
      title: 'Pikachu Decapitates Charizard',
    });
    expect(result.copyright.length).toBeGreaterThan(0);
    expect(result.monetization.length).toBeGreaterThan(0);
    expect(result.copyright).toContain('pikachu');
    // "decapitate" is advertiser-risk (monetization), NOT a hard safety term
    expect(result.monetization.some((h) => h.includes('decapit'))).toBe(true);
    expect(result.safety).toEqual([]);
  });

  it('returns empty arrays for clean content', () => {
    const result = policyHits({ title: 'A Cold Door' });
    expect(result.copyright).toEqual([]);
    expect(result.monetization).toEqual([]);
    expect(result.safety).toEqual([]);
  });
});

describe('Safety filter (hard block) vs monetization (advertiser-risk)', () => {
  it('flags a slur as a hard safety violation', () => {
    const r = checkSafety('the villain used the word retarded as an insult');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('retarded');
  });

  it('does NOT treat graphic-violence vocabulary as a safety violation', () => {
    // gore / massacre are legitimate horror-fiction words → monetization only
    expect(checkSafety('The scene depicted graphic gore across the walls').clean).toBe(true);
    expect(checkSafety('a massacre at dawn').clean).toBe(true);
  });

  it('still surfaces graphic-violence vocabulary as monetization (advertiser-risk)', () => {
    expect(checkMonetization('The scene depicted graphic gore across the walls').clean).toBe(false);
    expect(checkMonetization('a massacre at dawn').clean).toBe(false);
  });

  it('scanObjectForSafety finds safety terms nested in objects', () => {
    const hits = scanObjectForSafety({ seo: { description: 'buy cocaine now' } });
    expect(hits).toContain('cocaine');
  });

  it('no longer flags the benign word "chink" (removed as a false positive)', () => {
    expect(checkSafety('a chink in the armor let light through').clean).toBe(true);
    expect(checkMonetization('a chink in the armor let light through').clean).toBe(true);
  });

  it('does not flag the bare verb "retard" (only the slur "retarded" is blocked)', () => {
    expect(checkSafety('the treatment can retard the spread of rust').clean).toBe(true);
  });

  it('regression guard: known ambiguous-word false positives are NOT in any blocklist', () => {
    // Prevents a future edit from silently re-introducing words that are also
    // common English and caused (or would cause) production false positives:
    // "a chink in the armor", "retard the spread", "spic and span".
    const dir = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(
      readFileSync(resolve(dir, '../config/copyright-blocklist.json'), 'utf8')
    ) as { safety: string[]; monetization: string[] };
    const all = [...cfg.safety, ...cfg.monetization];
    for (const ambiguous of ['chink', 'retard', 'spic']) {
      expect(all).not.toContain(ambiguous);
    }
  });

  it('benign corpus: common English phrases do not false-positive', () => {
    const benign = [
      'a chink in the armor let the light through',
      'the chemical can retard the spread of rust',
      'the room was spic and span after cleaning',
      'she walked through the forest carrying a lantern at dusk',
      'a peaceful walk through the woods on a calm morning',
    ];
    for (const sentence of benign) {
      expect(checkSafety(sentence).clean).toBe(true);
      expect(checkMonetization(sentence).clean).toBe(true);
    }
  });
});

describe('H4 — safety/monetization evasion resistance', () => {
  it('catches punctuation-obfuscated safety terms', () => {
    expect(checkSafety('s.u.i.c.i.d.e').clean).toBe(false);
    expect(checkSafety('c-o-c-a-i-n-e').clean).toBe(false);
    expect(checkSafety('s-u-i-c-i-d-e').clean).toBe(false);
  });

  it('catches single-letter-spaced safety terms', () => {
    expect(checkSafety('f a g g o t').clean).toBe(false);
    expect(checkSafety('s u i c i d e').clean).toBe(false);
  });

  it('catches multiword safety terms with collapsed or hyphenated separators', () => {
    expect(checkSafety('kill myself').clean).toBe(false);
    expect(checkSafety('kill-myself').clean).toBe(false);
    expect(checkSafety('killmyself').clean).toBe(false);
  });

  it('does NOT treat "free" as a negation for safety terms', () => {
    expect(checkSafety('get free cocaine now').clean).toBe(false);
    expect(checkSafety('free heroin samples').clean).toBe(false);
  });

  it('still honors genuine negations for safety terms', () => {
    expect(checkSafety('this story contains no suicide at all').clean).toBe(true);
    expect(checkSafety('never use cocaine, kids').clean).toBe(true);
  });

  it('catches obfuscated monetization terms and redacts them from raw text', () => {
    const r = checkMonetization('blood and g-o-r-e everywhere');
    expect(r.clean).toBe(false);
    expect(r.hits).toContain('gore');
    expect(r.redacted).not.toContain('g-o-r-e');
  });

  it('still honors the broader negation set for monetization terms', () => {
    expect(checkMonetization('no gore in this story').clean).toBe(true);
    expect(checkMonetization('exclude torture from this story').clean).toBe(true);
  });

  it('does not false-positive on ordinary prose after the collapsed pass', () => {
    expect(checkSafety('something else entirely').clean).toBe(true);
    expect(checkSafety('a methodical approach to gardening').clean).toBe(true);
    expect(checkMonetization('the algorithm aggregates scores').clean).toBe(true);
  });
});
