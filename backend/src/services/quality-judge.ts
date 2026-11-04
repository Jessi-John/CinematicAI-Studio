/**
 * LLM-as-judge quality scoring.
 *
 * L4-QUALITY-LLM: stage 8 was using a pure-local heuristic (length
 * checks, power-word counts, etc.) and producing a grade in <10ms.
 * The user reported that this "quality score" was misleading because
 * no AI was actually judging the story — a 6ms heuristic cannot
 * evaluate narrative coherence, character voice, or hook strength
 * the way a reader would. This module adds a real LLM-as-judge call
 * that reads a digest of the story and returns a structured
 * {overallScore, grade, issues, strengths} verdict.
 *
 * The judge is intentionally SHORT (one focused LLM call) to keep the
 * cost of the quality gate negligible (~0.5% of total API spend). The
 * prompt asks for a single integer 0-100 plus a 1-2 sentence verdict
 * so the model can't be lazy and return a generic response.
 *
 * The judge has its own circuit breaker — if both Kimi K3
 * routes (blueprint + content) plus Mistral are all unavailable, we fall
 * back to the local heuristic and log a warning. The pipeline must never block
 * on a quality check; a heuristic fallback is acceptable.
 */
import { generateWithMistral } from '../lib/ai-client.js';
import { safeJsonParse } from '../lib/sanitize.js';
import { logger } from './logger.js';
import type { Story } from './types.js';

/**
 * SCHEMA-VALIDATION: Runtime shape check for LlmQualityVerdict.
 *
 * The LLM judge returns structured JSON. If the model changes its output format
 * (new field naming, missing fields, wrong types), this validation catches it
 * immediately and logs a structured warning so operators know the quality scores
 * fell back to defaults — instead of silently producing wrong metric mappings
 * (the pre-M31 bug where viralityScore = visualClarity).
 *
 * Every sub-score field is checked by name. If ANY field is missing or
 * not a 0-100 number, the function returns a descriptive error message.
 * This ensures the stage8-quality mapping (viralityScore = emotionalEngagement,
 * monetizationScore = plotCoherence, etc.) receives valid inputs.
 */
const QUALITY_SUBSCORE_KEYS = [
  'hook', 'pacing', 'characterVoice', 'visualClarity', 'plotCoherence',
  'emotionalEngagement', 'sceneUniqueness', 'conflictEscalation',
  'characterConsistency', 'worldConsistency', 'originality', 'endingQuality',
] as const;

function validateQualityVerdictShape(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'verdict is not an object';
  const v = raw as Record<string, unknown>;
  if (typeof v.overallScore !== 'number' || !Number.isFinite(v.overallScore)) {
    return 'overallScore is missing or not a finite number';
  }
  if (typeof v.grade !== 'string' || !['A', 'B', 'C', 'D', 'F'].includes(v.grade)) {
    return `grade is "${String(v.grade)}" — expected one of A/B/C/D/F`;
  }
  const sub = v.subScores;
  if (!sub || typeof sub !== 'object') return 'subScores is missing or not an object';
  for (const key of QUALITY_SUBSCORE_KEYS) {
    if (!(key in sub)) return `subScores.${key} is missing`;
    const val = (sub as Record<string, unknown>)[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 100) {
      return `subScores.${key} is "${String(val)}" — expected a number 0-100`;
    }
  }
  return null;
}

export interface LlmQualityVerdict {
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** One-sentence summary of what is working. */
  strength: string;
  /** One-sentence summary of the biggest issue (empty if grade >= B). */
  issue: string;
  /** 0-100 sub-scores used to explain the overall. */
  subScores: {
    hook: number;
    pacing: number;
    characterVoice: number;
    visualClarity: number;
    plotCoherence: number;
    emotionalEngagement: number;
    sceneUniqueness: number;
    conflictEscalation: number;
    /** Whether the protagonist sounds like the same person across all episodes. */
    characterConsistency: number;
    /** Whether the world/setting rules remain consistent. */
    worldConsistency: number;
    /** Whether the story feels fresh vs. generic. */
    originality: number;
    /** Whether the final episode's resolution is satisfying. */
    endingQuality: number;
  };
}

/**
 * Build a comprehensive digest of the story for the judge. Includes metadata
 * for every episode (hook, synopsis, cliffhanger) so the judge sees the full
 * arc, plus every scene narration for episodes 1, 5, and 10 (opening, middle,
 * ending anchors) to assess voice/consistency, plus a single scene sample from
 * the remaining episodes to detect broken scenes.
 */
export function buildJudgeDigest(story: Story): string {
  const lines: string[] = [];
  lines.push(`TITLE: ${story.title}`);
  lines.push(`GENRE: ${story.genre}`);
  if (story.theme) lines.push(`THEME: ${story.theme}`);

  const characters = story.characters || [];
  const protagonist = characters.find((c) => c.role === 'protagonist');
  if (protagonist) lines.push(`PROTAGONIST: ${protagonist.name}`);

  const episodes = (story.episodes || []).slice().sort((a, b) => a.number - b.number);

  for (const ep of episodes) {
    lines.push(`-- EP ${ep.number} (${ep.title}) --`);
    lines.push(`  hook: ${truncate(ep.hook, 220)}`);
    lines.push(`  synopsis: ${truncate(ep.synopsis, 220)}`);
    lines.push(`  cliffhanger: ${truncate(ep.cliffhanger, 220)}`);
    const scenes = (ep.scenes || []).slice().sort((a, b) => a.number - b.number);
    // M31: derive anchors from the ACTUAL episode count ({1, middle, last})
    // instead of hardcoding 1/5/10 — with a configurable episodesPerStory
    // (e.g. 12), the "ending anchor" was episode 10, not the end.
    const epCount = story.episodes.length;
    const midAnchor = Math.ceil(epCount / 2);
    const isAnchor = ep.number === 1 || ep.number === midAnchor || ep.number === epCount;
    if (isAnchor) {
      lines.push('  scenes:');
      for (const sc of scenes) {
        lines.push(`    scene ${sc.number}: ${truncate(sc.narration?.text || '', 260)}`);
      }
    } else if (scenes.length > 0) {
      const sc = scenes[0]!;
      lines.push(`  scene ${sc.number}: ${truncate(sc.narration?.text || '', 260)}`);
    }
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Run the LLM judge. Returns a verdict or null if the call fails for any
 * reason. Callers must handle null and fall back to a local heuristic
 * (or just accept the story without an LLM score) — the judge is best
 * effort, never blocking.
 */
export async function judgeStoryQuality(story: Story): Promise<LlmQualityVerdict | null> {
  if (!story.episodes || story.episodes.length === 0) return null;
  let digest = buildJudgeDigest(story);
  const maxDigestChars = 12000;
  if (digest.length > maxDigestChars) {
    logger.warn(
      { digestLength: digest.length, maxDigestChars },
      'L4-QUALITY-LLM: judge digest exceeded max length — truncating to preserve full-prompt coverage'
    );
    digest = digest.slice(0, maxDigestChars);
  }
  const systemPrompt = `You are a senior script editor reviewing a 10-episode anime story for a YouTube Shorts series. You have read the full digest below. Score the story honestly and concisely. Temperature=0 — produce identical output for identical input. Output JSON only.`;
  const userPrompt = `Read this story digest and judge its overall quality on a 0-100 integer scale. Be deterministic — identical stories always get identical scores.

SCORING GUIDE:
- 90-100 (A): Excellent — strong hook, consistent voice, clear character arcs, compelling pacing.
- 80-89 (B): Good — minor rough edges but fundamentally sound and publishable.
- 70-79 (C): Workable — readable but with one or two noticeable weak spots.
- 60-69 (D): Below average — multiple issues that benefit from targeted refinement.
- 0-59 (F): Unpublishable — incoherent or broken in some fundamental way.

SUB-SCORES (each 0-100):
- hook: how immediately the first episode grabs attention
- pacing: whether scenes feel rushed or drag
- characterVoice: whether the protagonist sounds like one consistent person
- visualClarity: whether the imagery is concrete and renderable
- plotCoherence: whether events follow logically
- emotionalEngagement: whether the story evokes feeling
- sceneUniqueness: whether each scene contributes something new
- conflictEscalation: whether stakes build across episodes
- characterConsistency: whether the protagonist's personality, speech, and decisions stay consistent across all episodes
- worldConsistency: whether the setting rules, lore, and atmosphere remain coherent
- originality: whether the story feels fresh vs. generic or trope-reliant
- endingQuality: whether the final episode's resolution is satisfying and earned

STORY DIGEST:
${digest}

Return ONLY this JSON, no commentary:
{
  "overallScore": <integer 0-100>,
  "grade": "A" | "B" | "C" | "D" | "F",
  "strength": "<one short sentence: what is working>",
  "issue": "<one short sentence: biggest issue, empty string if grade >= B>",
  "subScores": {
    "hook": <0-100>,
    "pacing": <0-100>,
    "characterVoice": <0-100>,
    "visualClarity": <0-100>,
    "plotCoherence": <0-100>,
    "emotionalEngagement": <0-100>,
    "sceneUniqueness": <0-100>,
    "conflictEscalation": <0-100>,
    "characterConsistency": <0-100>,
    "worldConsistency": <0-100>,
    "originality": <0-100>,
    "endingQuality": <0-100>
  }
}

STRICT JSON RULES:
- Never use double quotes inside string values (use single quotes or rephrase).
- The story is a ${story.genre || 'unknown-genre'} story: judge it AS that genre. Penalize overallScore when the story drifts off-genre (e.g. supernatural menace in a grounded genre, or a missing defining genre element).`;

  const JUDGE_MAX_ATTEMPTS = 3;
  let lastFailure = 'unknown';
  for (let attempt = 0; attempt < JUDGE_MAX_ATTEMPTS; attempt++) {
    const verdict = await attemptJudgeOnce(
      systemPrompt,
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\nREPAIR NOTE: Your previous response was not valid, parseable JSON (failure: ${lastFailure}). Return strictly valid JSON only — no commentary, no trailing commas, no unescaped quotes in strings.`
    );
    if (verdict.ok) return verdict.value;
    lastFailure = verdict.error;
    logger.warn(
      { attempt: attempt + 1, maxAttempts: JUDGE_MAX_ATTEMPTS, failure: lastFailure },
      'L4-QUALITY-LLM: judge attempt failed — retrying with repair note'
    );
  }
  logger.warn(
    { attempts: JUDGE_MAX_ATTEMPTS, lastFailure },
    'L4-QUALITY-LLM: judge unavailable after all attempts; caller should fall back'
  );
  return null;
}

type JudgeAttempt = { ok: true; value: LlmQualityVerdict } | { ok: false; error: string };

async function attemptJudgeOnce(systemPrompt: string, userPrompt: string): Promise<JudgeAttempt> {
  try {
    // QUALITY-JUDGE-MODEL: The judge is routed through the content-stage
    // provider path (Mistral first, then Kimi fallback) instead of the
    // blueprint-stage path. The content route handles the full ~13k-char
    // judge prompt with much lower latency while still returning a
    // deterministic JSON verdict.
    const raw = await generateWithMistral(systemPrompt, userPrompt, { stage: 'content', temperature: 0, maxTokens: 1200 });
    const parsed = safeJsonParse<LlmQualityVerdict>(raw);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'empty-or-non-object JSON' };

    // SCHEMA-VALIDATION: Every sub-score is checked by name. If the LLM
    // changes its output format, we log and fall back to null so the
    // pipeline uses local heuristics instead of silently producing wrong
    // metric mappings (the pre-M31 bug where viralityScore = visualClarity).
    const validationError = validateQualityVerdictShape(parsed);
    if (validationError) {
      return { ok: false, error: `shape validation failed: ${validationError}` };
    }

    const score = clampInt(parsed.overallScore, 0, 100);
    const grade = normalizeGrade(parsed.grade) ?? gradeFor(score);
    const sub = parsed.subScores ?? {};
    return {
      ok: true,
      value: {
        overallScore: score,
        grade,
        strength: typeof parsed.strength === 'string' ? parsed.strength.slice(0, 200) : '',
        issue: typeof parsed.issue === 'string' ? parsed.issue.slice(0, 200) : '',
        subScores: {
          hook: clampInt(sub.hook, 0, 100),
          pacing: clampInt(sub.pacing, 0, 100),
          characterVoice: clampInt(sub.characterVoice, 0, 100),
          visualClarity: clampInt(sub.visualClarity, 0, 100),
          plotCoherence: clampInt(sub.plotCoherence, 0, 100),
          emotionalEngagement: clampInt(sub.emotionalEngagement, 0, 100),
          sceneUniqueness: clampInt(sub.sceneUniqueness, 0, 100),
          conflictEscalation: clampInt(sub.conflictEscalation, 0, 100),
          characterConsistency: clampInt(sub.characterConsistency, 0, 100),
          worldConsistency: clampInt(sub.worldConsistency, 0, 100),
          originality: clampInt(sub.originality, 0, 100),
          endingQuality: clampInt(sub.endingQuality, 0, 100),
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : lo;
  return Math.max(lo, Math.min(hi, v));
}

function normalizeGrade(g: unknown): 'A' | 'B' | 'C' | 'D' | 'F' | null {
  if (typeof g !== 'string') return null;
  const upper = g.toUpperCase();
  if (['A', 'B', 'C', 'D', 'F'].includes(upper)) return upper as 'A' | 'B' | 'C' | 'D' | 'F';
  return null;
}

function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
