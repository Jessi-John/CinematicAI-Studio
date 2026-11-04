/**
 * Stage 3: Character bible.
 *
 * Generates the protagonist's personality / appearance / speech-pattern bible
 * that the humanization and visual-prompt stages both read from. The bible
 * is also the source of truth for the rendered character card on the
 * story detail page — its structured fields must always be populated
 * (BUG-004 / default fallback ensures this even when the LLM call fails).
 */

import type { StageContext, StageHelpers } from '../types.js';
import { generateCharacterBible } from '../../../../services/character-bible.js';
import { logFallback } from '../../../../services/generation-logger.js';
import { defaultCharacterBible } from '../helpers.js';
import { logger } from '../../../../services/logger.js';

export async function stage3CharacterBible(
  ctx: StageContext,
  { progressEmit, isStageDone, markStageDone, loadCandidate }: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'character_bible', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  if (await isStageDone('character_bible')) {
    await progressEmit(14, 'character_bible', 'Skipping character bible (already completed)...');
    const cand = await loadCandidate();
    if (cand && cand.characters && cand.characters.length > 0) {
      const protagonist = cand.characters.find((c) => c.role === 'protagonist');
      if (protagonist) {
        ctx.characterBible = {
          speechPatterns: protagonist.speechPatterns || 'Natural, authentic',
          clothing: protagonist.clothing || 'Genre-appropriate',
          facialFeatures: protagonist.facialFeatures || 'Expressive',
          emotions: protagonist.emotions || ['curiosity', 'determination'],
          relationships: protagonist.relationships || {},
          catchphrases: protagonist.catchphrases || [],
          physicalMannerisms: protagonist.physicalMannerisms || 'Natural gestures',
          gender: (protagonist.gender === 'male' || protagonist.gender === 'female' || protagonist.gender === 'neutral')
            ? protagonist.gender
            : 'neutral',
        };
        logger.info(
          { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'character_bible', elapsedMs: 0, skipped: true },
          'STAGE_COMPLETED'
        );
        return;
      }
    }
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId },
      'Character bible stage marked done but candidate/characters missing — using default bible'
    );
    ctx.characterBible = defaultCharacterBible();
    logger.info(
      { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'character_bible', elapsedMs: 0, skipped: true, fallback: true },
      'STAGE_COMPLETED'
    );
    return;
  }
  await progressEmit(14, 'character_bible', 'Generating character bible...');
  const blueprint = ctx.blueprint!;
  let characterBible;
  try {
    characterBible = await generateCharacterBible({
      name: blueprint.protagonistName,
      genre: ctx.primaryGenre,
      setting: blueprint.setting,
      role: 'protagonist',
      // M31: Pass the blueprint's protagonistGender as a seed hint to
      // the character-bible AI. The AI may still disagree (e.g. when
      // the seed is genuinely ambiguous), in which case the AI's
      // response overrides the seed. This keeps protagonist gender
      // consistent between Stage 2 and Stage 3 for unambiguous seeds.
      ...(blueprint.protagonistGender !== undefined ? { seedGender: blueprint.protagonistGender } : {}),
      // L4-CHAR-ROLE: Pass the user-typed seed so the bible knows the
      // narrative role the protagonist is supposed to play (e.g. "a
      // cartographer", "a thief", "a forgotten princess"). Without
      // this, the bible silently invents an archetype from a
      // genre-template lookup and may create conflicting supporting
      // characters — the production regression was a story whose seed
      // cast the protagonist as a cartographer, and Stage 3 generated
      // a "Lirael, a young cartographer" supporting character
      // alongside the protagonist "Arlo" (also a cartographer).
      ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logFallback('character_bible', errMsg, blueprint.protagonistName);
    characterBible = defaultCharacterBible();
  }
  await markStageDone('character_bible');
  ctx.characterBible = characterBible;
  // M31: Update blueprint.protagonistGender from the character bible's
  // resolved gender. This ensures the pronoun set used in Stage 5
  // matches the gender the LLM actually assigned during Stage 3. If
  // the character bible omitted the field (e.g. from a cached
  // checkpoint that predates M31), the existing blueprint value is
  // preserved.
  if (characterBible.gender) {
    ctx.blueprint = { ...blueprint, protagonistGender: characterBible.gender };
  }
  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'character_bible', elapsedMs: Math.round(elapsedMs) },
    'STAGE_COMPLETED'
  );
}
