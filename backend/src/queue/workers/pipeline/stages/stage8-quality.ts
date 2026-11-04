/**
 * Stage 8: Quality scoring.
 *
 * The LLM judge (judgeStoryQuality) is the PRIMARY quality signal.
 * Deterministic heuristics (calculateQualityPenalties) detect OBJECTIVE
 * defects — repetition, structural violations, continuity errors — and
 * apply penalty deductions to the LLM score.
 *
 *   finalScore = clamp(llmScore - totalPenalty)
 *
 * This replaces the previous 50/50 blend where heuristics tried to score
 * subjective dimensions (engagement, virality) and their average diluted
 * the semantic evaluation the LLM actually performed.
 *
 * If the LLM call fails, the stage falls back to a hardcoded floor-minus-
 * penalties score — the pipeline never blocks on the quality gate.
 *
 * THROWS a typed `QualityError` if the final score falls below the
 * configured floor. The orchestrator catches this and decides whether
 * to retry the whole pipeline or surface the failure.
 */

import type { StageContext, StageHelpers } from '../types.js';
import { calculateQualityPenalties } from '../../../../quality/index.js';
import { getAlgorithmTipsForGenre } from '../../../../lib/growth-tips.js';
import { judgeStoryQuality } from '../../../../services/quality-judge.js';
import { logger } from '../../../../services/logger.js';
import { QualityError } from '../quality-error.js';

export async function stage8Quality(
  ctx: StageContext,
  { progressEmit }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'quality', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  await progressEmit(85, 'quality', 'Calculating quality scores...');
  const story = ctx.story!;

  // 1. Run deterministic penalties for objective defects.
  const penalties = calculateQualityPenalties({
    episodes: story.episodes.map((ep) => ({
      hook: ep.hook,
      cliffhanger: ep.cliffhanger,
      scenes: ep.scenes.map((s) => ({ narration: s.narration.text })),
    })),
  });

  // 2. Run LLM judge as the primary quality signal.
  const llmVerdict = await judgeStoryQuality(story);
  const llmScore = llmVerdict?.overallScore ?? ctx.qualityFloor;

  // 3. Apply penalty deductions to the LLM score.
  const finalScore = Math.max(0, Math.min(100, llmScore - penalties.totalPenalty));
  const finalGrade = gradeFor(finalScore);

  // 4. Populate metadata with LLM sub-scores + penalty issues.
  // When the judge is unavailable after all retries, the fallback score
  // (floor minus penalties) must NEVER look like a genuine verdict: persist
  // an explicit diagnostic so operators can tell "scored 70 by the judge"
  // apart from "judge call failed and the floor was assumed".
  const judgeUnavailableNote =
    'Quality judge unavailable after all retry attempts — score is the fallback (floor minus penalties), not an LLM verdict';
  story.metadata.qualityScore = finalScore;
  story.metadata.qualityGrade = finalGrade;
  story.metadata.qualityRecommendations = llmVerdict && llmVerdict.issue
    ? [llmVerdict.strength, llmVerdict.issue].filter(Boolean)
    : [...penalties.issues, ...(!llmVerdict ? [judgeUnavailableNote] : [])];
  story.metadata.qualityIssues = [
    ...penalties.issues,
    ...(llmVerdict && llmVerdict.issue ? [llmVerdict.issue] : []),
    ...(!llmVerdict ? [judgeUnavailableNote] : []),
  ].filter(Boolean);
  const sub = llmVerdict?.subScores;
  story.metadata.viralityScore = sub?.emotionalEngagement ?? sub?.visualClarity ?? 75;
  story.metadata.hookStrength = llmVerdict?.subScores.hook ?? 75;
  story.metadata.retentionScore = llmVerdict?.subScores.pacing ?? 75;
  story.metadata.monetizationScore = sub?.plotCoherence ?? 75;
  story.metadata.algorithmTips = getAlgorithmTipsForGenre(ctx.primaryGenre, {
    title: story.title || 'Untitled Story',
    protagonistName: ctx.blueprint!.protagonistName,
    firstHook: ctx.episodes?.[0]?.hook || '',
  });

  ctx.qualityScore = finalScore;
  ctx.qualityGrade = finalGrade;
  ctx.qualityRecommendations = story.metadata.qualityRecommendations;
  // M16 FIX: Merge with any quality issues already set by stage 7 (e.g.
  // "Ending lacks a genre-appropriate hook") instead of overwriting them.
  ctx.qualityIssues = [...(ctx.qualityIssues ?? []), ...story.metadata.qualityIssues];

  if (llmVerdict) {
    logger.info(
      {
        jobId: ctx.jobId,
        requestId: ctx.requestId,
        llmScore,
        totalPenalty: penalties.totalPenalty,
        finalScore,
        strength: llmVerdict.strength,
        issue: llmVerdict.issue,
        subScores: llmVerdict.subScores,
      },
      'L4-QUALITY-LLM: judge verdict'
    );
  } else {
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId, penalties },
      'L4-QUALITY-LLM: judge unavailable — using floor-minus-penalties'
    );
  }

  // Originality is advisory — don't fail the gate on low originality alone
  // if all other quality dimensions are acceptable. Originality is inherently
  // subjective and varies by evaluator; retrying won't produce a more
  // "original" story, it will just waste API calls on a different variation.
  // H18: When the judge is unavailable (llmVerdict == null), the gate is
  // ADVISORY — the documented "pipeline never blocks on the quality gate"
  // behavior. Previously finalScore = floor − penalties < floor threw
  // QualityError, triggering a 3× full-pipeline retry storm against a judge
  // that was still down.
  if (finalScore < ctx.qualityFloor && llmVerdict) {
    const originalityOnly =
      llmVerdict &&
      llmVerdict.subScores.originality < 60 &&
      llmVerdict.subScores.hook >= 70 &&
      llmVerdict.subScores.pacing >= 70 &&
      llmVerdict.subScores.plotCoherence >= 70 &&
      llmVerdict.subScores.characterVoice >= 70 &&
      llmVerdict.subScores.emotionalEngagement >= 70 &&
      llmVerdict.subScores.conflictEscalation >= 70 &&
      llmVerdict.subScores.endingQuality >= 70 &&
      penalties.totalPenalty === 0;
    if (!originalityOnly) {
      throw new QualityError(
        `Story quality below floor: final=${finalScore} (llm=${llmScore}, penalties=${penalties.totalPenalty})`,
        finalScore,
        finalGrade,
        story.metadata.qualityIssues,
        story
      );
    }
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId, finalScore, originality: llmVerdict?.subScores.originality },
      'Quality floor not met but only originality is low — accepting (originality is advisory)'
    );
  }
  const GRADE_NUM: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  // H18: grade gate also advisory when the judge is unavailable.
  if (llmVerdict && (GRADE_NUM[finalGrade] ?? 0) < (GRADE_NUM[ctx.gradeFloor] ?? 0)) {
    throw new QualityError(
      `Story grade below floor: grade=${finalGrade} (floor ${ctx.gradeFloor})`,
      finalScore,
      finalGrade,
      story.metadata.qualityIssues,
      story
    );
  }
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    {
      jobId: ctx.jobId,
      requestId: ctx.requestId,
      stage: 'quality',
      elapsedMs: Math.round(elapsedMs),
      qualityScore: finalScore,
      qualityGrade: finalGrade,
    },
    'STAGE_COMPLETED'
  );
}

function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
