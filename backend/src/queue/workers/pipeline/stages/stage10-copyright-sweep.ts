/**
 * Stage 10: Copyright + safety + monetization sweep.
 *
 * Final gate before the story leaves the pipeline:
 *  - Copyright (IP) hits are REDACTED in-place so a takedown never happens.
 *  - Hard SAFETY hits (slurs, sexual exploitation, self-harm instructions,
 *    drug glorification, real-person impersonation) ABORT the job — these can
 *    never be published under any circumstance.
 *  - MONETIZATION (advertiser-risk) hits do NOT abort. Graphic-violence and
 *    similar vocabulary is legitimate in first-class genres like horror and
 *    dark-fantasy, so the narrative is preserved. Only the public YouTube
 *    listing (title / description / tags / hook) is redacted to keep the
 *    ad-facing metadata advertiser-friendly — which is the actual purpose of
 *    the monetization filter.
 */

import type { StageContext, StageHelpers } from '../types.js';
import {
  scanObject,
  scanObjectForSafety,
  scanObjectForHardSafety,
  redactGenreSensitiveSafetyTerms,
  checkMonetization,
} from '../../../../lib/copyright-filter.js';
import { redactStoryInPlace } from '../helpers.js';
import { logger } from '../../../../services/logger.js';

const GENRE_SENSITIVE_SAFETY_GENRES = new Set(['horror', 'dark-fantasy']);

/**
 * Redact advertiser-risk (monetization) terms from the public YouTube listing
 * only (the SEO block that is published to YouTube). The fictional narrative
 * (episodes / scenes / synopses) is intentionally left untouched so genres
 * like horror and dark-fantasy remain producible.
 */
function redactMonetizationInListing(story: {
  youtubeSeo?: {
    title: string;
    description: string;
    tags: string[];
    hookScript: string;
  } | null;
}): string[] {
  const seo = story.youtubeSeo;
  if (!seo) return [];
  const hits = new Set<string>();
  const redact = (value: string): string => {
    const r = checkMonetization(value);
    r.hits.forEach((h) => hits.add(h));
    return r.hits.length > 0 ? r.redacted : value;
  };
  seo.title = redact(seo.title);
  seo.description = redact(seo.description);
  seo.tags = seo.tags.map((t) => redact(t));
  seo.hookScript = redact(seo.hookScript);
  return Array.from(hits);
}

export async function stage10CopyrightSweep(
  ctx: StageContext,
  _helpers: StageHelpers
): Promise<void> {
  const stageStartedAt = process.hrtime.bigint();
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'copyright', startedAt: new Date().toISOString() },
    'STAGE_STARTED'
  );
  const story = ctx.story!;

  // 1. Copyright (IP) — redact in place.
  const copyrightHits = scanObject(story);
  if (copyrightHits.length > 0) {
    logger.warn({ jobId: ctx.jobId, requestId: ctx.requestId, hits: copyrightHits }, 'Copyright sweep flagged terms; redacting');
    redactStoryInPlace(story);
  }

  // 2. Hard safety — abort. These terms must never be published.
  //    M69: For horror/dark-fantasy genres, genre-sensitive safety terms
  //    (suicide, drugs, self-harm) in narrative fields are redacted rather
  //    than aborting — these terms are thematic vocabulary for the genre.
  //    Hard safety terms (slurs, sexual, real-person) always abort.
  const genre = (ctx.story!.genre ?? '').toLowerCase();
  const isGenreSensitive = GENRE_SENSITIVE_SAFETY_GENRES.has(genre);

  if (isGenreSensitive) {
    // Horror/dark-fantasy: only abort on hard safety (slurs, sexual, real-person).
    const hardHits = scanObjectForHardSafety(story);
    if (hardHits.length > 0) {
      throw new Error(
        `Safety-blocked content detected: ${hardHits.slice(0, 5).join(', ')}. The content contains terms that violate safety guidelines.`
      );
    }
    // Genre-sensitive terms (suicide, drugs) are redacted from narration
    // rather than aborting — they are legitimate horror vocabulary.
    const redactedTerms = redactGenreSensitiveSafetyTerms(story);
    if (redactedTerms.length > 0) {
      logger.warn(
        { jobId: ctx.jobId, requestId: ctx.requestId, genre, terms: redactedTerms },
        'Genre-sensitive safety terms redacted from narrative (horror/dark-fantasy)'
      );
    }
  } else {
    // All other genres: abort on ANY safety term.
    const safetyHits = scanObjectForSafety(story);
    if (safetyHits.length > 0) {
      throw new Error(
        `Safety-blocked content detected: ${safetyHits.slice(0, 5).join(', ')}. The content contains terms that violate safety guidelines.`
      );
    }
  }

  // 3. Monetization (advertiser-risk) — do NOT abort. Keep the narrative; only
  //    sanitize the public YouTube listing so the ad-facing metadata is clean.
  const monetizationHits = redactMonetizationInListing(story);
  if (monetizationHits.length > 0) {
    logger.warn(
      { jobId: ctx.jobId, requestId: ctx.requestId, hits: monetizationHits },
      'Monetization sweep redacted advertiser-risk terms from YouTube listing'
    );
  }

  const elapsedMs = Number(process.hrtime.bigint() - stageStartedAt) / 1_000_000;
  logger.info(
    { jobId: ctx.jobId, requestId: ctx.requestId, stage: 'copyright', elapsedMs: Math.round(elapsedMs) },
    'STAGE_COMPLETED'
  );
}
