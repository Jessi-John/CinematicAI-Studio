/**
 * Stage 7: Humanization.
 *
 * Runs each scene's narration through the humanization post-processor and
 * (if the AI-detection score is still too high) regenerates the scene via
 * the LLM. A per-story retry budget caps the worst-case number of regen
 * calls so a particularly un-humanizable story can't burn the token budget
 * for the rest of the queue.
 */

import type { StageContext, StageHelpers } from '../types.js';
import { humanization } from '../../../../humanization/index.js';
import { generateSingleScene, fixPronounMismatches, isStrongGenreEnding } from '../../../../lib/episode-generator.js';
import { buildVoiceoverText } from '../../../../lib/tts-normalize.js';
import { logger } from '../../../../services/logger.js';

const HUMANIZATION_MAX_RETRIES_PER_SCENE = 3;

export async function stage7Humanization(
  ctx: StageContext,
  { progressEmit }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'humanization', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  await progressEmit(80, 'humanization', 'Applying humanization...');
  const story = ctx.story!;
  let totalAiScore = 0;
  let sceneCount = 0;
  let retriesUsed = 0;

  // Collect all (episode, scene) pairs for parallel processing
  const tasks = new Array<{ ep: (typeof story.episodes)[number]; scene: (typeof story.episodes)[number]['scenes'][number] }>();
  for (const ep of story.episodes) {
    for (const scene of ep.scenes) {
      tasks.push({ ep, scene });
    }
  }

  // P5: Process scenes with limited concurrency (batch of 8) instead of all
  // 50 at once. Previously Promise.all over all 50 scenes with up to 3 AI
  // retries each = 150 concurrent calls queued behind the rate limiter mutex.
  // Batching reduces queue depth and prevents timeouts while waiting.
  const HUMANIZATION_CONCURRENCY = 8;
  const results: Array<{ epIndex: number; sceneIndex: number; text: string; aiScore: number; retries: number }> = [];
  for (let i = 0; i < tasks.length; i += HUMANIZATION_CONCURRENCY) {
    const batch = tasks.slice(i, i + HUMANIZATION_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async ({ ep, scene }) => {
    let humanized = humanization.process(scene.narration.text);
    let attempts = 0;
    let bestScore = humanized.aiScore;
    let bestText = humanized.text;
    // aiScore semantic (from humanization/index.ts: `aiScore: 0-100, lower = more human`):
    //   score starts at 100 and decreases for each AI indicator found.
    //   So HIGH score = clean prose (no AI patterns) = human-like.
    //   The retry fires when score is BELOW the threshold (text is too AI-like).
    // Default `aiScoreLimit=80` means: "text with score <80 (lots of AI patterns) needs regeneration."
    while (humanized.aiScore < ctx.aiScoreLimit && attempts < HUMANIZATION_MAX_RETRIES_PER_SCENE) {
      attempts += 1;
      logger.warn(
        { jobId: ctx.jobId, requestId: ctx.requestId, episode: ep.number, scene: scene.number, aiScore: humanized.aiScore, attempt: attempts },
        'Scene narration below quality floor, regenerating'
      );
      // Collect prior narration text from scenes in OTHER episodes so the
      // model knows what phrasing already exists and avoids repeating it.
      const __priorNarrations = story.episodes
        .filter((e) => e.number !== ep.number)
        .flatMap((e) => e.scenes.map((s) => s.narration.text));
      try {
        const regenerated = await generateSingleScene(
          scene.number,
          ep.number,
          story.title || 'Untitled Story',
          ctx.blueprint!.protagonistName,
          story.genre,
          ep.synopsis,
          ep.scenes[scene.number - 2]?.narration?.text || null,
          ctx.characterBible!,
          true,
          ctx.targetWordsPerScene,
          ctx.blueprint!.protagonistGender ?? 'neutral',
          undefined,
          humanized.lowScoreSentences.length > 0 ? humanized.lowScoreSentences : undefined,
          __priorNarrations
        );
        humanized = humanization.process(regenerated);
        if (humanized.aiScore <= bestScore && attempts >= 2) {
          // New score is no better (lower or equal) than best — we already
          // have a more human-like version, stop retrying.
          logger.warn(
            { jobId: ctx.jobId, requestId: ctx.requestId, episode: ep.number, scene: scene.number, prevScore: bestScore, newScore: humanized.aiScore },
            'Humanization retry did not improve aiScore — accepting best attempt'
          );
          humanized = { text: bestText, changes: [], aiScore: bestScore, lowScoreSentences: [] };
          break;
        }
        if (humanized.aiScore > bestScore) {
          // New score is higher (more human-like) — keep the improved version.
          bestScore = humanized.aiScore;
          bestText = humanized.text;
        }
      } catch (err) {
        logger.warn({ jobId: ctx.jobId, requestId: ctx.requestId, err, episode: ep.number, scene: scene.number }, 'Scene regeneration failed during humanization retry');
        break;
      }
    }
    return { epIndex: story.episodes.indexOf(ep), sceneIndex: ep.scenes.indexOf(scene), text: humanized.text, aiScore: humanized.aiScore, retries: attempts };
    }));
    results.push(...batchResults);
  }

  // Write results back from the parallel pass and sum retries
  // (per-scene retries tracked locally to avoid race on shared counter)
  let totalRetries = 0;
  for (const r of results) {
    const ep = story.episodes[r.epIndex];
    if (!ep) {
      logger.warn({ epIndex: r.epIndex }, 'Stage7 humanization: episode not found, skipping');
      continue;
    }
    const scene = ep.scenes[r.sceneIndex];
    if (!scene) {
      logger.warn({ epIndex: r.epIndex, sceneIndex: r.sceneIndex }, 'Stage7 humanization: scene not found, skipping');
      continue;
    }
    scene.narration.text = r.text;
    totalAiScore += r.aiScore;
    sceneCount += 1;
    totalRetries += r.retries;
  }
  retriesUsed = totalRetries;

  // --- Second pass: cross-scene repetition detection ---
  // Uses the unused detectRepetition() method on the humanization service to
  // catch scenes that share repeated phrasing across episodes (a common failure
  // mode of parallel generation that the sequential pipeline previously caught).
  // Regenerates duplicate scenes with the humanization retry prompt.
  //
  // Diversity gate: if more than 30% of checked scenes are flagged, abort the
  // entire repetition pass. High systemic flag rate means the AI provider is
  // producing low-diversity output (e.g., 429s, canned mode, or a model that
  // can't vary its prose). Per-scene retries won't fix it — they just waste
  // API calls and time. The gate kicks in after at least 3 scenes have been
  // checked to avoid false triggers on small stories.
  const repetitionBudget = Math.max(0, Math.min(ctx.storyBudget - retriesUsed, 10));
  let repetitionRetries = 0;
  let repetitionChecked = 0;
  let repetitionFlagged = 0;
  if (repetitionBudget > 0 && sceneCount > 0) {
    const allEntries = story.episodes.flatMap((ep) =>
      ep.scenes.map((s) => ({ ep, scene: s, text: s.narration.text }))
    );
    for (let i = 0; i < allEntries.length && repetitionRetries < repetitionBudget; i++) {
      const { ep, scene } = allEntries[i]!;
      // Read live from the scene object — allEntries captures references to
      // scene objects, so scene.narration.text always reflects the latest state
      // even if an earlier scene in this loop was already regenerated.
      const currentText = scene.narration.text;
      const otherTexts = allEntries
        .filter((_, j) => j !== i)
        .map((e) => e.scene.narration.text);

      const repResult = humanization.detectRepetition(currentText, otherTexts);
      repetitionChecked++;
      if (!repResult.hasRepetition) continue;
      repetitionFlagged++;

      // Diversity gate: if >60% of scenes are flagged and we've checked
      // at least 5, abort — it's a systemic quality issue (e.g. canned mode,
      // model producing identical output), not fixable per-scene.
      if (repetitionChecked >= 5 && (repetitionFlagged / repetitionChecked) > 0.6) {
        logger.warn(
          {
            jobId: ctx.jobId,
            requestId: ctx.requestId,
            checked: repetitionChecked,
            flagged: repetitionFlagged,
            ratio: (repetitionFlagged / repetitionChecked).toFixed(2),
          },
          'Cross-scene repetition rate exceeds 60% — aborting repetition pass (systemic quality issue)'
        );
        break;
      }

      // Regenerate on either signal: internal trigram repetition (e.g. "the
      // the the") OR near-exact cross-scene similarity (>= 0.95 Jaccard).
      // The near-exact threshold catches exact duplicate scenes that differ
      // only in shared vocabulary (protagonist name, setting terms). A score
      // of 0.95 means ~95% word overlap — practically the same text. Lower
      // scores (0.7-0.94) CAN be unavoidable vocabulary overlap from sharing
      // the same protagonist, setting, and genre terms, so we only regenerate
      // when the match is near-exact.
      if (repResult.repeatedPhrases.length === 0 && repResult.similarityScore < 0.95) {
        logger.info(
          {
            jobId: ctx.jobId,
            requestId: ctx.requestId,
            episode: ep.number,
            scene: scene.number,
            similarityScore: repResult.similarityScore.toFixed(2),
            threshold: 0.95,
          },
          'Cross-scene similarity within vocabulary-overlap range — skipping regeneration'
        );
        continue;
      }

      logger.warn(
        {
          jobId: ctx.jobId,
          requestId: ctx.requestId,
          episode: ep.number,
          scene: scene.number,
          similarityScore: repResult.similarityScore.toFixed(2),
          repeatedPhrases: repResult.repeatedPhrases,
        },
        'Cross-scene repetition detected — regenerating with targeted feedback'
      );

      try {
        // FIX: Pass the specific repeated phrases as the humanizationReason
        // so the model knows EXACTLY which phrases to avoid. Previously the
        // retry prompt was generic ("too formulaic or AI-sounding") with no
        // specific feedback, so the model rewrote using the same repetitive
        // patterns and the retry always failed (stillRepetitive: true).
        //
        // Cross-episode context: pass narration from other episodes so the
        // model knows what phrasing already exists and will not repeat it.
        const __priorNarrations = story.episodes
          .filter((e) => e.number !== ep.number)
          .flatMap((e) => e.scenes.map((s) => s.narration.text));
        const currentHumanized = humanization.process(scene.narration.text);
        const regenerated = await generateSingleScene(
          scene.number,
          ep.number,
          story.title || 'Untitled Story',
          ctx.blueprint!.protagonistName,
          story.genre,
          ep.synopsis,
          ep.scenes[scene.number - 2]?.narration?.text || null,
          ctx.characterBible!,
          true,
          ctx.targetWordsPerScene,
          ctx.blueprint!.protagonistGender ?? 'neutral',
          repResult.repeatedPhrases,
          currentHumanized.lowScoreSentences.length > 0 ? currentHumanized.lowScoreSentences : undefined,
          __priorNarrations
        );
        const humanized = humanization.process(regenerated);
        const recheck = humanization.detectRepetition(humanized.text, otherTexts);
        if (!recheck.hasRepetition && humanized.aiScore >= ctx.aiScoreLimit) {
          totalAiScore -= humanization.process(scene.narration.text).aiScore;
          scene.narration.text = humanized.text;
          totalAiScore += humanized.aiScore;
          repetitionRetries += 1;
          logger.info(
            {
              jobId: ctx.jobId,
              requestId: ctx.requestId,
              episode: ep.number,
              scene: scene.number,
              newAiScore: humanized.aiScore,
            },
            'Cross-scene repetition resolved'
          );
        } else {
          logger.warn(
            {
              jobId: ctx.jobId,
              requestId: ctx.requestId,
              episode: ep.number,
              scene: scene.number,
              newAiScore: humanized.aiScore,
              stillRepetitive: recheck.hasRepetition,
            },
            'Cross-scene repetition retry did not resolve — keeping original'
          );
        }
      } catch (err) {
        logger.warn(
          { jobId: ctx.jobId, requestId: ctx.requestId, err, episode: ep.number, scene: scene.number },
          'Cross-scene repetition regeneration failed — keeping original'
        );
      }
    }
  }

  retriesUsed += repetitionRetries;

  // Post-generation pronoun consistency fix: scan every scene for pronoun
  // mismatches relative to the protagonist's declared gender and repair them
  // deterministically. This catches LLM prompt-noncompliance without an
  // expensive regeneration — a simple string replacement.
  const protagonistName = ctx.blueprint?.protagonistName;
  const protagonistGender = ctx.blueprint?.protagonistGender ?? 'neutral';
  if (protagonistName) {
    // MEDIUM #35: build the explicit named-entity list from the story's
    // characters and the world bible (antagonist / supporting / environments)
    // so pronoun fixes only rewrite the protagonist's pronouns, not another
    // character's or a place's.
    const characterNames = (story.characters ?? ctx.story?.characters ?? [])
      .map((c) => c.name)
      .filter((n): n is string => typeof n === 'string');
    const worldBible = ctx.worldBible;
    const worldNames = worldBible
      ? [
          worldBible.antagonist?.name,
          worldBible.supporting?.name,
          ...(worldBible.environments?.map((e) => e.name) ?? []),
        ].filter((n): n is string => typeof n === 'string')
      : [];
    const otherNamedEntities = Array.from(new Set([...characterNames, ...worldNames]));

    let totalPronounFixes = 0;
    for (const ep of story.episodes) {
      for (const scene of ep.scenes) {
        const fixed = fixPronounMismatches(
          scene.narration.text,
          protagonistName,
          protagonistGender,
          otherNamedEntities
        );
        if (fixed.changes.length > 0) {
          scene.narration.text = fixed.text;
          totalPronounFixes += fixed.changes.length;
          logger.info(
            { jobId: ctx.jobId, requestId: ctx.requestId, episode: ep.number, scene: scene.number, fixes: fixed.changes.length },
            'Pronoun consistency fix applied'
          );
        }
      }
    }
    if (totalPronounFixes > 0) {
      logger.info(
        { jobId: ctx.jobId, requestId: ctx.requestId, totalFixes: totalPronounFixes },
        'Pronoun consistency pass complete'
      );
    }
  }

  // Genre-aware ending evaluation: for the last episode's scene 5, verify the
  // ending hooks the viewer in a way that fits the genre (tension genres need
  // a cliffhanger; gentle/uplifting genres accept warmth, humor, hope, or
  // curiosity). Deterministic check runs first (0 API cost). Only on failure
  // do we call the LLM to confirm. On confirmed failure, flag for retry.
  const lastEp = story.episodes[story.episodes.length - 1];
  if (lastEp) {
    const lastScene = lastEp.scenes[lastEp.scenes.length - 1];
    if (lastScene) {
      const cliffhangerSentences = lastScene.narration.text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const lastSentence = cliffhangerSentences[cliffhangerSentences.length - 1]?.trim() || '';
      if (lastSentence && !isStrongGenreEnding(lastSentence, ctx.primaryGenre)) {
        // Deterministic check failed — confirm with LLM before rejecting
        const { evaluateCliffhangerSemantic } = await import('../../../../lib/episode-generator.js');
        const semanticPass = await evaluateCliffhangerSemantic(lastSentence, ctx.primaryGenre);
        if (!semanticPass) {
          logger.warn(
            { jobId: ctx.jobId, requestId: ctx.requestId, genre: ctx.primaryGenre, lastSentence: lastSentence.slice(0, 100) },
            'Semantic ending evaluation failed — story ending lacks a genre-appropriate hook'
          );
          ctx.qualityIssues = [...(ctx.qualityIssues || []), 'Ending lacks a genre-appropriate hook'];
        }
      }
    }
  }

  // Build voiceover text per episode after all scene changes
  for (const ep of story.episodes) {
    ep.voiceoverText = buildVoiceoverText({
      hook: ep.hook,
      scenes: ep.scenes.map((s) => s.narration.text),
      cliffhanger: ep.cliffhanger,
    });
  }
  story.metadata.humanizationScore = sceneCount > 0 ? Math.round(totalAiScore / sceneCount) : 100;
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'humanization', elapsedMs: Math.round(elapsedMs), sceneCount },
    'STAGE_COMPLETED'
  );
}
