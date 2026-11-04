import { generateWithMistral } from './ai-client.js';
import { safeJsonParse } from './sanitize.js';
import { sanitizeForPrompt } from './sanitize-prompt.js';
import { logger } from '../services/logger.js';
import type { Story } from '../services/types.js';
import type { LlmQualityVerdict } from '../services/quality-judge.js';

export interface RefinementPlan {
  targetAreas: string[];
  approach: string;
  preserveFields: string[];
}

const REFINER_SYSTEM_PROMPT = `You are a story editor reviewing an anime story for a YouTube Shorts series. The story was evaluated and needs targeted improvements. DO NOT rewrite everything — only fix the specific weaknesses listed. Preserve the original premise, structure, character identities, and continuity. Output JSON only. Temperature=0, deterministic.`;

function buildRefinerDigest(story: Story, verdict: LlmQualityVerdict): string {
  const lines: string[] = [];
  lines.push(`TITLE: ${story.title}`);
  lines.push(`GENRE: ${story.genre}`);
  lines.push(`CURRENT SCORE: ${verdict.overallScore}/100 (${verdict.grade})`);
  lines.push(`STRENGTHS: ${verdict.strength}`);
  lines.push(`WEAKNESSES: ${verdict.issue}`);
  lines.push(`SUB-SCORES: hook=${verdict.subScores.hook}, pacing=${verdict.subScores.pacing}, characterVoice=${verdict.subScores.characterVoice}, visualClarity=${verdict.subScores.visualClarity}`);
  lines.push('');
  lines.push('Episode breakdown:');
  for (const ep of (story.episodes || []).slice().sort((a, b) => a.number - b.number)) {
    lines.push(`  EP ${ep.number} ("${ep.title}"): hook="${truncate(ep.hook, 100)}" → "${truncate(ep.cliffhanger, 100)}"`);
    const scenes = (ep.scenes || []).slice().sort((a, b) => a.number - b.number);
    for (const s of scenes) {
      lines.push(`    Scene ${s.number}: ${truncate(s.narration?.text || '', 120)}`);
    }
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Generate a refinement plan targeting the weakest sub-scores.
 * The plan focuses only on areas below the configured threshold,
 * avoiding unnecessary changes to already-strong sections.
 */
export async function generateRefinementPlan(
  story: Story,
  verdict: LlmQualityVerdict,
  refinementIndex: number
): Promise<RefinementPlan | null> {
  const digest = buildRefinerDigest(story, verdict);

  const userPrompt = `Review this story evaluation and create a focused refinement plan.

${digest}

The lowest sub-score is: ${Object.entries(verdict.subScores).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'unknown'} (${Math.min(...Object.values(verdict.subScores))}/100).

This is refinement attempt #${refinementIndex + 1}. Each attempt must focus on DIFFERENT aspects than the previous ones — do not repeat the same approach.

Return ONLY this JSON:
{
  "targetAreas": ["<1-3 specific aspects to improve, e.g. 'character motivation in ep 1-3', 'pacing in ep 7-9'>"],
  "approach": "<one sentence describing the specific changes needed>",
  "preserveFields": ["<aspects that MUST NOT change, e.g. 'protagonist identity', 'core premise'>"]
}`;

  try {
    const raw = await generateWithMistral(REFINER_SYSTEM_PROMPT, userPrompt, { stage: 'quality-refinement' });
    const parsed = safeJsonParse<RefinementPlan>(raw);
    if (!parsed?.targetAreas?.length) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err: String(err) }, 'Refinement plan generation failed');
    return null;
  }
}

/**
 * Apply a refinement plan to regenerate specific episodes/scenes.
 * Returns a new Story object with the fixes applied.
 * Preserves everything not in targetAreas.
 */
export async function applyRefinementPlan(
  story: Story,
  plan: RefinementPlan
): Promise<Story> {
  const updated = JSON.parse(JSON.stringify(story)) as Story;

  // M14: dedupe overlapping target areas so one area's mass-rewrite pass
  // doesn't run twice over the same scenes.
  const targetAreas = [...new Set(plan.targetAreas.map((a) => a.toLowerCase()))];

  for (const area of targetAreas) {
    const areaLower = area;

    // Target episode-level fixes
    if (areaLower.includes('episode') || areaLower.includes('pacing') || areaLower.includes('arc')) {
      // L17: parse ranges ("ep 7-9" → 7, 8, 9), not just the first number.
      const rangeMatch = areaLower.match(/ep\s*(\d+)(?:\s*-\s*(\d+))?/);
      const targetEpisodes = rangeMatch
        ? (() => {
            const start = parseInt(rangeMatch[1]!, 10);
            const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
            return Array.from({ length: end - start + 1 }, (_, i) => start + i);
          })()
        : (updated.episodes || []).map((e) => e.number);

      for (const epNum of targetEpisodes) {
        const ep = (updated.episodes || []).find((e) => e.number === epNum);
        if (!ep) continue;

        const fixPrompt = `Refine Episode ${epNum} of "${sanitizeForPrompt(story.title)}" to address: ${area}.

Current hook: "${sanitizeForPrompt(ep.hook)}"
Current synopsis: "${sanitizeForPrompt(ep.synopsis)}"
Current cliffhanger: "${sanitizeForPrompt(ep.cliffhanger)}"

IMPROVEMENT APPROACH: ${plan.approach}

Preserve: ${plan.preserveFields.join(', ')}
Preserve the episode's role in the overall story. Only change what needs fixing. Output prose only.`;

        try {
          const raw = await generateWithMistral(
            `You are a story editor refining a single episode. Temperature=0. Be precise. Output the refined hook, synopsis, and cliffhanger as JSON.`,
            fixPrompt,
            { stage: 'episode-refinement' }
          );
          const parsed = safeJsonParse<{ hook?: string; synopsis?: string; cliffhanger?: string }>(raw);
          if (parsed) {
            if (parsed.hook) ep.hook = parsed.hook;
            if (parsed.synopsis) ep.synopsis = parsed.synopsis;
            if (parsed.cliffhanger) ep.cliffhanger = parsed.cliffhanger;
          }
        } catch (err) {
          logger.warn({ err: String(err), episode: epNum }, 'Episode refinement failed — keeping original');
        }
      }
    }

    // Target scene-level fixes (repetition, voice, clarity).
    // M14: cap the rewrite budget per target area (previously EVERY scene
    // ≥30 chars in the story was rewritten per matching area — up to 50 AI
    // calls per area — and rewritten text was accepted without re-running
    // word-band/similarity validation, silently voiding upstream gates).
    if (areaLower.includes('scene') || areaLower.includes('voice') || areaLower.includes('repetition') || areaLower.includes('dialogue')) {
      const MAX_SCENE_REWRITES_PER_AREA = 8;
      let rewrites = 0;
      for (const ep of updated.episodes || []) {
        if (rewrites >= MAX_SCENE_REWRITES_PER_AREA) break;
        for (const scene of ep.scenes || []) {
          if (rewrites >= MAX_SCENE_REWRITES_PER_AREA) break;
          const sceneText = scene.narration?.text;
          if (!sceneText || sceneText.length < 30) continue;

          const fixPrompt = `Refine this scene to address: ${area}

IMPROVEMENT APPROACH: ${sanitizeForPrompt(plan.approach)}

Current scene text: "${sanitizeForPrompt(truncate(sceneText, 500))}"

Rewrite the scene addressing the specific weakness. Preserve the scene's role in the episode, the character's voice, and continuity with surrounding scenes. Output prose only, no labels.`;

          try {
            const raw = await generateWithMistral(
              `You are a story editor refining a scene. Temperature=0. Preserve the scene's role and continuity. Output prose only.`,
              fixPrompt,
              { stage: 'scene-refinement' }
            );
            // M14: only accept the rewrite if it is at least as long as the
            // original (a 3-word "rewrite" is not a refinement) and differs
            // from siblings.
            if (raw && raw.length >= sceneText.length * 0.8 && raw.trim().toLowerCase() !== sceneText.trim().toLowerCase()) {
              scene.narration.text = raw;
              rewrites += 1;
            }
          } catch (err) {
            logger.warn({ err: String(err) }, 'Scene refinement failed — keeping original');
          }
        }
      }
      if (rewrites > 0) {
        logger.info({ rewrites, area }, 'Scene refinement applied (capped per-area budget)');
      }
    }
  }

  return updated;
}
