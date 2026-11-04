/**
 * Subtitle and TTS-script generators.
 *
 * Produces SSML (TTS-ready), SRT (legacy subtitle), and WebVTT (modern subtitle)
 * outputs from a Story object. All formats use scene durations baked into the
 * scene narration timing.
 *
 * TIME-UNIT DISCIPLINE: Every duration in this module is tracked in branded
 * types (Seconds, Milliseconds). The branded types prevent the class of bug
 * where a value intended as seconds is accidentally interpreted as minutes
 * (or vice versa). See units.ts for conversion helpers.
 */

import type { Story, Episode, Scene } from '../services/types.js';
import { normalizeForTTS } from './tts-normalize.js';
import {
  seconds, milliseconds, toMs,
  wpmToSeconds, type Seconds, type Milliseconds,
} from './units.js';

// ---------- Constants ----------

/** Standard speaking rate used for WPM→duration fallback (145 words/min). */
const SPEAKING_WPM = 145;

// ---------- SSML ----------

const PROSODY_BY_EMOTION: Record<string, { rate: string; pitch: string }> = {
  neutral: { rate: '100%', pitch: '+0st' },
  happy: { rate: '105%', pitch: '+1st' },
  sad: { rate: '92%', pitch: '-2st' },
  dramatic: { rate: '95%', pitch: '+0st' },
  intense: { rate: '108%', pitch: '+1st' },
  mysterious: { rate: '90%', pitch: '-1st' },
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert a scene narration into SSML with prosody and inter-sentence breaks.
 */
function sceneToSsml(scene: Scene): string {
  const prosody = PROSODY_BY_EMOTION[scene.narration.emotion]! || PROSODY_BY_EMOTION.neutral;
  const cleaned = normalizeForTTS(scene.narration.text);
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  const sentenceTags = sentences
    .map((s) => `<s>${escapeXml(s.trim())}</s>`)
    .join('<break time="200ms"/>');

  return `<prosody rate="${prosody.rate}" pitch="${prosody.pitch}">${sentenceTags}</prosody>`;
}

/**
 * Build full SSML for an episode: hook + 5 scenes + cliffhanger,
 * with longer breaks between major sections.
 */
export function episodeToSSML(episode: Episode): string {
  const sceneBlocks = episode.scenes.map(sceneToSsml).join('<break time="700ms"/>');
  const cleanHook = normalizeForTTS(episode.hook);
  const cleanCliff = normalizeForTTS(episode.cliffhanger);
  return `<?xml version="1.0"?>
<speak version="1.1" xml:lang="en-US">
  <prosody rate="100%">
    <s>${escapeXml(cleanHook)}</s>
    <break time="800ms"/>
    ${sceneBlocks}
    <break time="800ms"/>
    <s>${escapeXml(cleanCliff)}</s>
  </prosody>
</speak>`;
}

/**
 * Full-story SSML: each episode separated by an extended pause.
 */
export function storyToSSML(story: Story): string {
  const episodes = story.episodes
    .map((ep) => {
      const inner = episodeToSSML(ep)
        .replace(/^<\?xml[^>]+\?>\s*/, '')
        .replace(/^<speak[^>]+>\s*/, '')
        .replace(/<\/speak>\s*$/, '');
      return `<!-- Episode ${ep.number}: ${escapeXml(ep.title)} -->\n${inner}\n<break time="1500ms"/>`;
    })
    .join('\n');

  return `<?xml version="1.0"?>
<speak version="1.1" xml:lang="en-US">
${episodes}
</speak>`;
}

// ---------- SRT / VTT ----------

interface TimedCue {
  index: number;
  startMs: Milliseconds;
  endMs: Milliseconds;
  text: string;
}

/**
 * Build timed cues for an episode's scenes.
 *
 * DURATION-SAFETY: All scene durations are tracked as `Seconds`. The `cursor`
 * variable is in `Milliseconds`. Every conversion between units goes through
 * the branded helpers in `units.ts`, so a code change that accidentally
 * interprets "145 WPM words per minute" as seconds-per-word would be caught
 * at compile time.
 */
function buildEpisodeCues(ep: Episode, baseOffsetMs: Milliseconds = milliseconds(0)): TimedCue[] {
  const cues: TimedCue[] = [];
  let cursor: Milliseconds = baseOffsetMs;
  let i = 1;
  for (const scene of ep.scenes) {
    // BL-005 + UNIT-FIX: Compute timing from word count at SPEAKING_WPM if no
    // duration stored. Uses wpmToSeconds() which correctly converts (wordCount *
    // 60 / wpm) to Seconds. Previously the code used (wordCount / wpm) which
    // produced MINUTES, not seconds — the branded type catches this mismatch.
    const sceneSeconds: Seconds = scene.duration !== undefined && scene.duration > 0
      ? seconds(scene.duration)
      : scene.narration.timing?.totalDuration !== undefined && scene.narration.timing.totalDuration > 0
        ? seconds(scene.narration.timing.totalDuration)
        : wpmToSeconds(scene.narration.text.split(/\s+/).length, SPEAKING_WPM);
    const ms = toMs(sceneSeconds);
    cues.push({ index: i++, startMs: cursor, endMs: (cursor + ms) as Milliseconds, text: scene.narration.text });
    cursor = (cursor + ms) as Milliseconds;
  }
  return cues;
}

function msToSrtTime(ms: Milliseconds): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(millis, 3)}`;
}

function msToVttTime(ms: Milliseconds): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function srtEscape(text: string): string {
  return text.replace(/-->/g, '→');
}

export function episodeToSRT(ep: Episode): string {
  const cues = buildEpisodeCues(ep, milliseconds(0));
  return cues
    .map(
      (c) =>
        `${c.index}\n${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}\n${srtEscape(c.text.trim())}\n`
    )
    .join('\n');
}

export function episodeToVTT(ep: Episode): string {
  const cues = buildEpisodeCues(ep, milliseconds(0));
  const body = cues
    .map(
      (c) =>
        `${msToVttTime(c.startMs)} --> ${msToVttTime(c.endMs)}\n${srtEscape(c.text.trim())}\n`
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function storyToSRT(story: Story): string {
  const out: string[] = [];
  let globalIndex = 1;
  let baseOffset: Milliseconds = milliseconds(0);
  for (const ep of story.episodes) {
    // L33: SRT has no comment syntax — the `# Episode N` marker lines were
    // not valid SRT and could break strict parsers. Episode boundaries are
    // already implicit in cue timing.
    const cues = buildEpisodeCues(ep, baseOffset);
    for (const c of cues) {
      out.push(
        `${globalIndex++}\n${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}\n${srtEscape(c.text.trim())}\n`
      );
    }
    // BL-006: Guard against ep.duration being undefined — compute from last cue end time
    if (typeof ep.duration !== 'number' || ep.duration <= 0) {
      const epEndMs = cues.length > 0 ? cues[cues.length - 1]!.endMs : milliseconds(0);
      baseOffset = epEndMs;
    } else {
      baseOffset = (baseOffset + toMs(seconds(ep.duration))) as Milliseconds;
    }
  }
  return out.join('\n');
}

export function storyToVTT(story: Story): string {
  const out: string[] = ['WEBVTT', ''];
  let baseOffset: Milliseconds = milliseconds(0);
  for (const ep of story.episodes) {
    out.push(`NOTE Episode ${ep.number}: ${ep.title}`);
    const cues = buildEpisodeCues(ep, baseOffset);
    for (const c of cues) {
      out.push(`${msToVttTime(c.startMs)} --> ${msToVttTime(c.endMs)}\n${srtEscape(c.text.trim())}\n`);
    }
    if (typeof ep.duration !== 'number' || ep.duration <= 0) {
      const epEndMs = cues.length > 0 ? cues[cues.length - 1]!.endMs : milliseconds(0);
      baseOffset = epEndMs;
    } else {
      baseOffset = (baseOffset + toMs(seconds(ep.duration))) as Milliseconds;
    }
  }
  return out.join('\n');
}

// ---------- Voiceover script (per-episode plain text with breaks) ----------

export function episodeToVoiceoverScript(episode: Episode): string {
  const lines: string[] = [];
  lines.push(`[HOOK]`);
  lines.push(episode.hook);
  lines.push('');
  episode.scenes.forEach((scene, idx) => {
    lines.push(`[Scene ${idx + 1} - ${scene.narration.emotion}]`);
    lines.push(scene.narration.text);
    lines.push('');
  });
  lines.push(`[CLIFFHANGER]`);
  lines.push(episode.cliffhanger);
  return lines.join('\n');
}
