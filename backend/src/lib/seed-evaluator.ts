import { generateWithMistral } from './ai-client.js';
import { safeJsonParse } from './sanitize.js';
import { sanitizeForPrompt } from './sanitize-prompt.js';
import { formatGenreDirective } from './genre-directives.js';
import { logger } from '../services/logger.js';
import { getSystemSettingInt, getSystemSetting } from '../services/settings.js';

export interface SeedEvaluation {
  overallScore: number;
  isValid: boolean;
  criteria: {
    originality: number;
    clarity: number;
    specificity: number;
    protagonistDefinition: number;
    conflict: number;
    setting: number;
    emotionalPotential: number;
    narrativePotential: number;
    audienceSuitability: number;
    ambiguity: number;
    uniqueness: number;
    genreConformance: number;
  };
  strengths: string[];
  weaknesses: string[];
  enrichmentSuggestion: string | null;
}

export interface EnrichedSeed {
  original: string;
  enriched: string;
  changes: string[];
}

const SEED_SYSTEM_PROMPT = `You are a creative story editor evaluating seed concepts for a 10-episode anime YouTube Shorts series. Score each criterion 0-100. Output JSON only. Temperature=0, deterministic.`;

function buildSeedUserPrompt(genre: string, seed: string): string {
  return `Evaluate this ${genre} story seed for a 10-episode YouTube Shorts anime series:

"${sanitizeForPrompt(seed)}"

${formatGenreDirective(genre)}

Score each criterion 0-100:

- originality: how unique and non-derivative the concept is
- clarity: how easily the core premise is understood
- specificity: how concrete and detailed the seed is (vs vague)
- protagonistDefinition: whether a clear protagonist role/identity emerges
- conflict: whether a source of tension or stakes is present
- setting: whether a distinctive time/place/world is suggested
- emotionalPotential: whether the seed naturally evokes emotion
- narrativePotential: whether the seed can sustain 10 episodes
- audienceSuitability: whether the content is YouTube-appropriate
- ambiguity: whether the seed leaves useful room for creative interpretation (not confusion)
- uniqueness: whether the concept is distinct from common tropes
- genreConformance: whether the concept follows the genre's REQUIRED ELEMENTS and avoids the FORBIDDEN ELEMENTS above (low score if it drifts into another genre)

When scoring genreConformance, be strict: if the seed is for comedy but contains horror/dread, or for slice-of-life but contains supernatural/magic, or for drama but contains impossible phenomena, score it below 40.

Also list 1-3 strengths, 1-3 weaknesses, and (if overall < 70) an enrichment suggestion that preserves the user's original intent AND respects the genre rules above.

Output ONLY this JSON:
{
  "overallScore": <0-100>,
  "criteria": { "originality": <0-100>, "clarity": <0-100>, "specificity": <0-100>, "protagonistDefinition": <0-100>, "conflict": <0-100>, "setting": <0-100>, "emotionalPotential": <0-100>, "narrativePotential": <0-100>, "audienceSuitability": <0-100>, "ambiguity": <0-100>, "uniqueness": <0-100>, "genreConformance": <0-100> },
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "weaknesses": ["<weakness 1>", "<weakness 2>", "<weakness 3>"],
  "enrichmentSuggestion": "<only if overallScore < 70: a 1-2 sentence enrichment that expands the seed without changing the user's intent and without drifting into forbidden genres> or null"
}`;
}

export async function evaluateSeed(
  genre: string,
  seed: string,
  thresholdOverride?: number
): Promise<SeedEvaluation> {
  const threshold = thresholdOverride ?? await getSystemSettingInt('seed_quality_threshold', 50);

  const userPrompt = buildSeedUserPrompt(genre, seed);
  // M13: safeJsonParse THROWS on unparseable input — the previous
  // `if (!parsed ...)` fallback was dead code, so provider outages and
  // malformed JSON rejected the job instead of accepting the seed as the
  // log line intends. Wrap the call and apply the accept-fallback on ANY
  // failure (parse or provider), which is the documented fail-open design.
  let parsed: SeedEvaluation;
  try {
    const raw = await generateWithMistral(SEED_SYSTEM_PROMPT, userPrompt, { stage: 'blueprint' });
    parsed = safeJsonParse<SeedEvaluation>(raw);
  } catch (err) {
    logger.warn({ err, seed: seed.slice(0, 80) }, 'Seed evaluator failed — accepting seed (fail-open)');
    return {
      overallScore: threshold + 1,
      isValid: true,
      criteria: {
        originality: 70, clarity: 70, specificity: 70, protagonistDefinition: 70,
        conflict: 70, setting: 70, emotionalPotential: 70, narrativePotential: 70,
        audienceSuitability: 90, ambiguity: 50, uniqueness: 70, genreConformance: 70,
      },
      strengths: ['Seed accepted by fallback evaluator'],
      weaknesses: [],
      enrichmentSuggestion: null,
    };
  }
  if (typeof parsed.overallScore !== 'number') {
    logger.warn({ seed: seed.slice(0, 80) }, 'Seed evaluator returned unparseable response — accepting seed');
    return {
      overallScore: threshold + 1,
      isValid: true,
      criteria: {
        originality: 70, clarity: 70, specificity: 70, protagonistDefinition: 70,
        conflict: 70, setting: 70, emotionalPotential: 70, narrativePotential: 70,
        audienceSuitability: 90, ambiguity: 50, uniqueness: 70, genreConformance: 70,
      },
      strengths: ['Seed accepted by fallback evaluator'],
      weaknesses: [],
      enrichmentSuggestion: null,
    };
  }

  // Defensive normalization: the AI may return malformed JSON where the array
  // fields are missing or non-arrays. Without this, enrichSeed's
  // `evaluation.weaknesses.map(...)` throws a TypeError on such a response.
  // Coerce to clean string arrays and null out a non-string suggestion.
  const rawParsed = parsed as unknown as {
    strengths?: unknown;
    weaknesses?: unknown;
    enrichmentSuggestion?: unknown;
  };
  parsed.strengths = Array.isArray(rawParsed.strengths)
    ? rawParsed.strengths.filter((s): s is string => typeof s === 'string')
    : [];
  parsed.weaknesses = Array.isArray(rawParsed.weaknesses)
    ? rawParsed.weaknesses.filter((w): w is string => typeof w === 'string')
    : [];
  parsed.enrichmentSuggestion =
    typeof rawParsed.enrichmentSuggestion === 'string' && rawParsed.enrichmentSuggestion.length > 0
      ? rawParsed.enrichmentSuggestion
      : null;

  parsed.isValid = parsed.overallScore >= threshold;
  return parsed;
}

export async function enrichSeed(
  genre: string,
  original: string,
  evaluation: SeedEvaluation
): Promise<EnrichedSeed | null> {
  const enabled = await getSystemSetting('auto_refinement_enabled', 'true');
  if (enabled !== 'true') return null;

  if (!evaluation.enrichmentSuggestion) return null;

  const systemPrompt = `You are a creative editor. Enrich the following story seed while preserving the user's original intent. DO NOT change the core premise, protagonist concept, or genre. You must respect the genre definition and forbidden elements below. Output JSON only. Temperature=0, deterministic.`;

  const userPrompt = `Original seed: "${sanitizeForPrompt(original)}"
Genre: ${sanitizeForPrompt(genre)}

${formatGenreDirective(genre)}

Editor feedback:
${evaluation.weaknesses.map((w) => `- ${sanitizeForPrompt(w)}`).join('\n')}

Enrichment suggestion:
${sanitizeForPrompt(evaluation.enrichmentSuggestion)}

Return ONLY this JSON:
{
  "enriched": "<the enriched seed, 1-2 sentences, same genre, same protagonist intent, NO forbidden elements from the genre directive above>",
  "changes": ["<specific change 1>", "<specific change 2>"]
}`;

  try {
    const raw = await generateWithMistral(systemPrompt, userPrompt, { stage: 'blueprint' });
    const parsed = safeJsonParse<{ enriched?: string; changes?: string[] }>(raw);
    if (!parsed?.enriched || parsed.enriched.length < 10) return null;
    return { original, enriched: parsed.enriched, changes: parsed.changes ?? [] };
  } catch (err) {
    logger.warn({ err: String(err) }, 'Seed enrichment failed — proceeding with original');
    return null;
  }
}
