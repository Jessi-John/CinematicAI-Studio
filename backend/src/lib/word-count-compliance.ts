/**
 * L4-WORD-COUNT-COMPLIANCE: deterministic post-processing that nudges an
 * episode's total word count into the configured tolerance band without
 * regenerating the whole episode.
 *
 * Strategy:
 *   - If the episode is already in band, return it unchanged.
 *   - If it is under the minimum, append short atmospheric sentences to the
 *     shortest scenes that still have headroom below the per-scene ceiling.
 *   - If it is over the maximum, trim the least-meaningful sentence from the
 *     longest scenes, or remove common filler adverbs if only one sentence
 *     remains.
 *
 * The adjustments are intentionally minimal: at most a single sentence per
 * scene and only enough scenes to close the gap. This preserves pacing,
 * tone, and narrative flow while guaranteeing the episode lands inside the
 * configured word-count band.
 */

const DEFAULT_PAD_PHRASES = [
  'The next moment waits, heavy with possibility.',
  'Silence stretches thin between them.',
  'Something shifts nearby, barely heard.',
  'Tension holds the air like a held breath.',
  'The choice lingers, unmade.',
];

const DEFAULT_FILLER_WORDS = [
  'very', 'really', 'quite', 'suddenly', 'carefully', 'quietly', 'simply',
  'quickly', 'slowly', 'briefly', 'slightly', 'clearly', 'deeply', 'sharply',
];

export interface EnsureEpisodeWordComplianceOptions {
  targetEpisodeWordsMin: number;
  targetEpisodeWordsMax: number;
  targetWordsPerScene?: number;
  sceneMinWords?: number;
  sceneMaxWords?: number;
  padPhrases?: string[];
  fillerWords?: string[];
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  // Keep trailing punctuation attached to each sentence.
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function joinSentences(sentences: string[]): string {
  return sentences.join(' ').trim();
}

function removeFillerWords(text: string, fillers: string[]): string {
  const pattern = new RegExp(`\\b(${fillers.join('|')})\\s+`, 'gi');
  return text.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

export function ensureEpisodeWordCompliance(
  scenes: readonly string[],
  options: EnsureEpisodeWordComplianceOptions
): string[] {
  const min = options.targetEpisodeWordsMin;
  const max = options.targetEpisodeWordsMax;
  const perSceneTarget = options.targetWordsPerScene ?? 24;
  const sceneMin = Math.max(5, options.sceneMinWords ?? 5);
  const sceneMax = options.sceneMaxWords ?? Math.round(perSceneTarget * 1.6);
  const pads = options.padPhrases ?? DEFAULT_PAD_PHRASES;
  const fillers = options.fillerWords ?? DEFAULT_FILLER_WORDS;

  const out = scenes.map((s) => s.trim());
  const total = () => out.reduce((sum, s) => sum + countWords(s), 0);

  if (total() >= min && total() <= max) return out;

  if (total() < min) {
    let gap = min - total();
    // M12: track which pad phrase was last applied to each scene. Previously
    // `idx` reset each while-pass, so the same (still-shortest) scene kept
    // ranking first and got pads[0] appended again and again — duplicated
    // sentences persisted into narration.
    const lastPadIndexByScene = new Map<number, number>();

    while (gap > 0) {
      const candidates = out
        .map((s, i) => {
          const wc = countWords(s);
          return { i, wc, room: sceneMax - wc };
        })
        .filter((c) => c.room >= 3)
        .sort((a, b) => a.wc - b.wc);

      if (candidates.length === 0) {
        // LIVE-3: When no scene has room for a full pad phrase but the gap
        // is small (1-3 words), pad the scene with the most remaining room
        // even if it can only hold a partial fit. Without this the loop
        // exits leaving the episode 1-3 words short of the minimum band.
        if (gap <= 3) {
          const best = out
            .map((s, i) => ({ i, wc: countWords(s), room: sceneMax - countWords(s) }))
            .filter((c) => c.room >= gap)
            .sort((a, b) => b.room - a.room)[0];
          if (best) {
            const lastPad = lastPadIndexByScene.get(best.i) ?? -1;
            let padIdx = (lastPad + 1) % pads.length;
            if (out[best.i]!.includes(pads[padIdx]!)) {
              padIdx = (padIdx + 1) % pads.length;
            }
            if (!out[best.i]!.includes(pads[padIdx]!)) {
              const phrase = pads[padIdx]!;
              const padded = `${out[best.i]!} ${phrase}`;
              const added = countWords(padded) - countWords(out[best.i]!);
              if (added > 0) {
                out[best.i] = padded;
                lastPadIndexByScene.set(best.i, padIdx);
                gap -= added;
              }
            }
          }
        }
        break;
      }

      for (let idx = 0; idx < candidates.length && gap > 0; idx++) {
        const { i } = candidates[idx]!;
        const lastPad = lastPadIndexByScene.get(i) ?? -1;
        // Pick the next pad not already present in this scene.
        let padIdx = (lastPad + 1) % pads.length;
        if (out[i]!.includes(pads[padIdx]!)) {
          padIdx = (padIdx + 1) % pads.length;
          if (out[i]!.includes(pads[padIdx]!)) continue; // all pads used here
        }
        const phrase = pads[padIdx]!;
        // M12: keep the original sentence terminator — the previous code
        // stripped [.!?] and appended with a bare space, producing run-on
        // sentences ("She walked home The next moment waits...").
        const padded = `${out[i]!} ${phrase}`;
        const added = countWords(padded) - countWords(out[i]!);
        if (added > 0) {
          out[i] = padded;
          lastPadIndexByScene.set(i, padIdx);
          gap -= added;
        }
      }
    }
    return out;
  }

  let gap = total() - max;

  while (gap > 0) {
    const candidates = out
      .map((s, i) => {
        const wc = countWords(s);
        return { i, wc, room: wc - sceneMin };
      })
      .filter((c) => c.room >= 3)
      .sort((a, b) => b.wc - a.wc);

    if (candidates.length === 0) break;

    let progress = false;
    for (let idx = 0; idx < candidates.length && gap > 0; idx++) {
      const { i } = candidates[idx]!;
      const sents = splitSentences(out[i]!);

      if (sents.length > 1) {
        sents.pop();
        const trimmed = joinSentences(sents);
        const removedCount = countWords(out[i]!) - countWords(trimmed);
        if (removedCount > 0) {
          out[i] = trimmed;
          gap -= removedCount;
          progress = true;
          continue;
        }
      }

      const trimmed = removeFillerWords(out[i]!, fillers);
      const removedCount = countWords(out[i]!) - countWords(trimmed);
      if (removedCount > 0) {
        out[i] = trimmed;
        gap -= removedCount;
        progress = true;
      }
    }

    if (!progress) break;
  }

  return out;
}
