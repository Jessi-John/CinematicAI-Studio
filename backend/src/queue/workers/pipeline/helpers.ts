/**
 * Phase 2 / Fix #21: helper functions extracted from story.worker.ts.
 *
 * The previous monolith had these defined at file scope; the stage modules
 * and orchestrator both need them. Centralizing them here keeps the stage
 * files small and lets the test in story.worker.test.ts continue to test
 * the same contracts by re-implementing the logic.
 */

import type { CharacterBible } from '../../../services/character-bible.js';
import type { WorldBible } from '../../../services/world-bible.js';
import type { Story, Environment } from '../../../services/types.js';
import { checkText } from '../../../lib/copyright-filter.js';

/**
 * BIZ-002 / BUG-004: default character bible that the rendered character
 * card can always show, even if the LLM call failed or the user-requested
 * genre has no canonical protagonist. All structured fields are populated
 * so the card is never blank.
 */
export function defaultCharacterBible(): CharacterBible {
  return {
    speechPatterns: 'Authentic, natural cadence',
    clothing: 'Genre-appropriate clothing',
    facialFeatures: 'Expressive features',
    emotions: ['curiosity', 'determination', 'wonder'],
    relationships: {},
    catchphrases: [],
    physicalMannerisms: 'Natural gestures',
    gender: 'neutral',
  };
}

/**
 * BIZ-003 / BUG-004: symmetric default world bible. Same rationale as
 * defaultCharacterBible — every structured field is populated so the
 * rendered supporting-cast / environment cards are never blank.
 *
 * L4-ENV-MULTI: returns the new `environments` array shape with a single
 * primary entry. The legacy `environment` field is mirrored from
 * environments[0] for backward compat with code that still reads the
 * singular field.
 */
export function defaultWorldBible(): WorldBible {
  const primary: Omit<Environment, 'id'> = {
    name: 'Unknown Setting',
    description: 'A world whose rules reveal themselves through the story',
    type: 'mixed',
    timeOfDay: 'varied',
    weather: 'varied',
    mood: 'atmospheric',
    keyFeatures: ['distinctive landmarks', 'shifting light', 'symbolic spaces'],
    colorPalette: ['deep tones', 'highlights of contrast'],
    lighting: {
      primary: 'motivated by scene',
      ambient: 'soft fill',
      colorTemperature: 'neutral',
      shadows: 'soft',
    },
  };
  return {
    antagonist: {
      name: 'Unknown Antagonist',
      description: 'A mysterious figure whose motives unfold through the story',
      appearance: 'A presence felt before they are seen',
      personality: 'Calculating and patient',
      role: 'antagonist',
      speechPatterns: 'Measured, deliberate, weighted',
      clothing: 'Indistinct, dark, formal',
      facialFeatures: 'Sharp, watchful, unsmiling',
      emotions: ['resolve', 'opposition'],
      catchphrases: [],
      physicalMannerisms: 'Stillness that reads as threat',
    },
    supporting: {
      name: 'Unknown Ally',
      description: 'A steadfast companion who provides perspective and aid',
      appearance: 'Weathered but reliable',
      personality: 'Loyal and quietly observant',
      role: 'supporting',
      speechPatterns: 'Warm, supportive, attentive',
      clothing: 'Practical, lived-in attire',
      facialFeatures: 'Open, trustworthy face',
      emotions: ['warmth', 'patience'],
      catchphrases: [],
      physicalMannerisms: 'Calm gestures',
    },
    environments: [primary],
    environment: primary,
  };
}

/**
 * Replace any well-known IP name in a string with a neutral placeholder.
 * The caller has already detected hits via hasCopyrightHit + scanObject.
 *
 * q-L17: Uses checkText() (the real filter) to cover ALL tiers (forbidden,
 * safety, monetization) instead of a hardcoded subset. The previous narrow
 * regex list silently left hits like "howl"/"kiki" in place.
 */
export function sanitizeFreeOfHits(value: string, _ctx: unknown, _genre: string): string {
  const r = checkText(value);
  return r.clean ? value : r.redacted;
}

/** Apply sanitizeFreeOfHits to every user-visible string in a Story. */
export function redactStoryInPlace(story: Story): void {
  // H5: Redact with the real filter (checkText().redacted) so the redaction
  // covers EVERY term the scanner flags — the previous narrow regex list in
  // sanitizeFreeOfHits silently left hits like "howl"/"kiki" in place, and
  // youtubeSeo was never touched at all, so flagged IP terms survived in the
  // exact fields published to YouTube.
  const redact = (s: string): string => {
    const r = checkText(s);
    return r.clean ? s : r.redacted;
  };
  story.title = redact(story.title);
  if (story.theme) story.theme = redact(story.theme);
  if (story.seed) story.seed = redact(story.seed);
  for (const c of story.characters) {
    c.name = redact(c.name);
    c.description = redact(c.description);
    c.appearance = redact(c.appearance);
    c.personality = redact(c.personality);
    // L15: Redact additional character fields that scanObject may scan.
    if (c.speechPatterns) c.speechPatterns = redact(c.speechPatterns);
    if (c.clothing) c.clothing = redact(c.clothing);
    if (c.facialFeatures) c.facialFeatures = redact(c.facialFeatures);
    if (c.physicalMannerisms) c.physicalMannerisms = redact(c.physicalMannerisms);
    if (c.catchphrases) c.catchphrases = c.catchphrases.map(redact);
  }
  for (const e of story.environments) {
    e.name = redact(e.name);
    e.description = redact(e.description);
    // L15: Redact additional environment fields.
    if (e.type) e.type = redact(e.type);
    if (e.colorPalette) e.colorPalette = e.colorPalette.map(redact);
  }
  for (const ep of story.episodes) {
    ep.title = redact(ep.title);
    ep.hook = redact(ep.hook);
    ep.synopsis = redact(ep.synopsis);
    ep.cliffhanger = redact(ep.cliffhanger);
    if (ep.voiceoverScript) ep.voiceoverScript = redact(ep.voiceoverScript);
    if (ep.voiceoverText) ep.voiceoverText = redact(ep.voiceoverText);
    if (ep.musicSuggestions) ep.musicSuggestions = ep.musicSuggestions.map(redact);
    if (ep.soundDesign) ep.soundDesign = ep.soundDesign.map(redact);
    for (const scene of ep.scenes) {
      scene.narration.text = redact(scene.narration.text);
      if (scene.narration.emotion) scene.narration.emotion = redact(scene.narration.emotion) as typeof scene.narration.emotion;
      scene.imagePrompt.content = redact(scene.imagePrompt.content);
      scene.videoPrompt.content = redact(scene.videoPrompt.content);
    }
  }
  // H5: The YouTube SEO block is scanned by scanObject but was previously
  // never redacted — flagged IP terms survived in the public listing.
  const seo = story.youtubeSeo;
  if (seo) {
    seo.title = redact(seo.title);
    seo.description = redact(seo.description);
    seo.tags = seo.tags.map(redact);
    seo.hookScript = redact(seo.hookScript);
    seo.ctaScript = redact(seo.ctaScript);
    seo.thumbnailSuggestions = seo.thumbnailSuggestions.map(redact);
    seo.trendingKeywords = seo.trendingKeywords.map(redact);
    if (seo.videoTemplate) seo.videoTemplate = redact(seo.videoTemplate);
    if (seo.targetAudience) seo.targetAudience = redact(seo.targetAudience);
    if (seo.recommendedDuration) seo.recommendedDuration = redact(seo.recommendedDuration);
    if (seo.algorithmBoostTips) seo.algorithmBoostTips = seo.algorithmBoostTips.map(redact);
  }
}
