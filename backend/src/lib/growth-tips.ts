/**
 * Genre-aware YouTube algorithm & growth recommendations.
 *
 * Returns 5 actionable tips per genre, optionally personalised with story context
 * so tips are not identical for every story in the same genre.
 */

import type { Genre } from '../services/types.js';

export interface GrowthTipsContext {
  title?: string;
  protagonistName?: string;
  firstHook?: string;
}

/**
 * Extract a story-specific keyword from context (title or hook) to inject into
 * hashtags and title tips. Returns empty string if no strong keyword found.
 */
function extractKeyword(ctx: GrowthTipsContext): string {
  const text = [ctx.title, ctx.firstHook].filter(Boolean).join(' ');
  if (!text) return '';
  // Grab the first meaningful word (length >= 4, not a common stop-word).
  const stopWords = new Set(['that', 'this', 'from', 'with', 'have', 'been', 'will', 'your', 'their', 'what', 'when', 'where', 'which']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  for (const w of words) {
    if (w.length >= 4 && !stopWords.has(w)) return w;
  }
  return '';
}

const TIPS: Record<Genre, string[]> = {
  fantasy: [
    'Post between 6-9 PM in your audience time zone — fantasy peaks during evening browsing.',
    'Lead the title with a specific magical noun ("The Hollow Crown") rather than a generic adjective.',
    'Pin a comment teasing Episode 2 within the first hour to drive watch-through.',
    'Use #fantasyshort #animefantasy #shortfilm — trending evergreen tags.',
    'Thumbnail: a single character against an ethereal background, no clutter, large-eye focal point.',
  ],
  adventure: [
    'Schedule for Saturday/Sunday morning when adventure content over-indexes.',
    'Open with a wide-shot motion frame in the first second to hook scroll-stoppers.',
    'Title formula: "[Verb] [Place]" — "Crossing the Sunken Reach".',
    'Cross-promote with a vertical Reels/TikTok trailer cut from your hook scene.',
    'Tag with #adventureshort #cinematicstory #animatedshort.',
  ],
  romance: [
    'Best slot: 8-11 PM. Romance audiences watch in the evening wind-down.',
    'Lead the description with the emotional hook in the first 80 characters (the YT preview cap).',
    'Pin the most-quotable line as the top comment to seed engagement.',
    'Use a soft-pastel thumbnail with two characters, eye contact, shallow depth.',
    'Tag with #romanceanime #lovestory #animatedshort #shorts.',
  ],
  horror: [
    'Schedule for late night (10 PM - 1 AM) when horror watch-time peaks.',
    'Hook in the first 1.5 s with a still image and a single off-frame sound cue.',
    'Title formula: an open question or a number — "The 13th Step", "What Lives in the Walls?".',
    'Thumbnail: high-contrast cold palette, partial-face composition, no gore.',
    'Tag with #horrorshort #scarystory #animatedhorror #shorts.',
  ],
  mystery: [
    'Schedule for weekday lunch (12-2 PM) — mystery indexes high on commute breaks.',
    'Title with a question ending in "?" to trigger curiosity-gap clicks.',
    'Pin a comment asking viewers to guess the culprit — replies inflate engagement signals.',
    'Thumbnail: an object close-up (a key, a letter) with a tight vignette.',
    'Tag with #mysteryshort #whodunit #animatedmystery #shorts.',
  ],
  thriller: [
    'Schedule for Friday night (8-11 PM) when thriller indexes hardest.',
    'Open with a sound + camera shake combo in the first frame to stop scrolling.',
    'Title formula: time-pressure verb + setting — "Race to the Last Train".',
    'Thumbnail: a single character in motion against a wet-asphalt night palette.',
    'Tag with #thrillershort #animatedthriller #suspense #shorts.',
  ],
  'sci-fi': [
    'Best slot: 7-10 PM weekdays — sci-fi peaks alongside gaming traffic.',
    'Lead title with a worldbuilding noun — "The Chorus Engine", "Concordia-9".',
    'First-second frame should show a sci-fi UI element to declare genre instantly.',
    'Thumbnail: cyan/magenta lighting on a single subject; avoid generic spaceships.',
    'Tag with #scifishort #animescifi #animated #shorts.',
  ],
  drama: [
    'Best slot: 6-10 PM. Drama plays well in the evening unwind window.',
    'Lead the description with a one-line emotional truth, not a plot summary.',
    'Pin a comment quoting the most affecting line.',
    'Thumbnail: tight face-frame with a soft warm key-light.',
    'Tag with #dramashort #animatedstory #emotional #shorts.',
  ],
  comedy: [
    'Schedule for Wednesday afternoon and weekend mornings — comedy mid-week dip is real.',
    'First two seconds should land a visual joke, not setup.',
    'Title formula: short, declarative, surprising — "Cat Yells at Soup".',
    'Thumbnail: exaggerated facial expression, bright primary colors.',
    'Tag with #comedyshort #funnyanimation #animated #shorts.',
  ],
  action: [
    'Schedule for Friday/Saturday 7-10 PM.',
    'Open with motion in the first frame; static frames lose action audiences.',
    'Title formula: high-energy verb + stakes — "Last Stand on the Bridge".',
    'Thumbnail: motion blur, sparks, single subject mid-action.',
    'Tag with #actionshort #anime #animated #shorts.',
  ],
  emotional: [
    'Best slot: late evening (9-11 PM) when emotional content over-indexes.',
    'Description should open with the feeling, not the plot.',
    'Pin a comment that names the feeling — encourages viewers to share theirs.',
    'Thumbnail: warm rim-light, single character, glistening eye detail.',
    'Tag with #emotionalstory #animatedstory #wholesome #shorts.',
  ],
  mythology: [
    'Schedule for early evening; mythology indexes near history viewers.',
    'Title with a real myth-tradition reference — ensures search discoverability.',
    'Thumbnail: monumental scale, gold/ivory palette, single subject silhouette.',
    'Pin a comment naming the myth lineage to drive curiosity.',
    'Tag with #mythology #animatedmyth #legend #shorts.',
  ],
  historical: [
    'Schedule for weekday early evening.',
    'Title with a date or place — "1923, Marrakech" — to inherit search intent.',
    'Description should land one historically resonant detail in line one.',
    'Thumbnail: muted period palette, single subject mid-action.',
    'Tag with #historicalshort #animatedhistory #periodpiece #shorts.',
  ],
  'slice-of-life': [
    'Schedule for weekend mid-morning when slice-of-life indexes best.',
    'Title with a specific everyday verb — "She Brewed the Last Tea".',
    'Pin a quiet, oddly specific comment from the protagonist.',
    'Thumbnail: warm window light, subject doing one quiet action.',
    'Tag with #sliceoflife #cozyanimation #animated #shorts.',
  ],
  'dark-fantasy': [
    'Schedule for late night.',
    'Title with archaic-feeling nouns — "The Reckoning of Ash".',
    'Thumbnail: midnight blue palette, crimson accent, ruined architecture.',
    'Pin a comment quoting the antagonist; their voice should feel iconic.',
    'Tag with #darkfantasy #animatedshort #anime #shorts.',
  ],
  psychological: [
    'Schedule for late evening to align with introspective audiences.',
    'Title formula: short, ambiguous, a single resonant noun — "The Mirror".',
    'Description should plant a single doubt in line one.',
    'Thumbnail: single-source cold light, distorted reflection element.',
    'Tag with #psychological #animatedthriller #mindbending #shorts.',
  ],
  inspirational: [
    'Schedule for Monday morning (5-8 AM) — inspirational content peaks early week.',
    'Title with a forward-looking verb — "She Climbed the Wall".',
    'Description should open with a one-line truth the viewer can carry into their day.',
    'Thumbnail: warm horizon, single subject in upward motion.',
    'Tag with #motivation #inspirationalstory #animatedshort #shorts.',
  ],
  kids: [
    'Schedule for weekend mornings (8-11 AM) when family viewing peaks.',
    'Title with a friendly noun + verb — "The Lost Lantern Finds a Friend".',
    'Description must declare the audience age explicitly (e.g. "for ages 4-8").',
    'Thumbnail: bright primary colors, big-eyed character, smiling expression.',
    'Tag with #kidsstory #animationforkids #wholesome #shorts.',
  ],
  survival: [
    'Schedule for late afternoon when adventure / survival traffic spikes.',
    'Title with stakes — "Three Days Without Water".',
    'Open with the protagonist in distress; survival hooks need stakes in the first frame.',
    'Thumbnail: weathered subject, harsh natural palette, single resource visible.',
    'Tag with #survival #animatedstory #wilderness #shorts.',
  ],
  'anime-style': [
    'Schedule for evenings (7-10 PM).',
    'Title with a stylized name + a specific event — "Kana and the Last Festival".',
    'Thumbnail: classic cel-shaded composition, expressive eyes.',
    'Pin a comment in-character to seed roleplay engagement.',
    'Tag with #anime #animatedshort #anistory #shorts.',
  ],
  'viral-trend': [
    'Schedule within 24 hours of when a trend peaks; relevance decays fast.',
    'First frame must reference the trend visually within 0.5 s.',
    'Title with the trend hashtag verbatim plus your twist.',
    'Thumbnail: bold contrast, large readable on-screen text (≤4 words).',
    'Tag with the active trend hashtags plus #shorts.',
  ],
};

/**
 * Get growth/algorithm tips for a genre, optionally personalised with story context.
 * When ctx is provided, a story-specific keyword is injected into hashtag tips
 * and the posting-time tip so identical-genre stories get distinct guidance.
 */
export function getAlgorithmTipsForGenre(genre: string, ctx?: GrowthTipsContext): string[] {
  const key = genre.toLowerCase() as Genre;
  const base = TIPS[key] ?? TIPS.fantasy;
  if (!ctx) return [...base];

  const keyword = extractKeyword(ctx);
  if (!keyword) return [...base];

  // Inject keyword into the hashtag tip (index 3) and posting-time tip (index 0).
  const tips = [...base];
  if (keyword.length >= 4) {
    const tag = `#${keyword.slice(0, 12)}`;
    // Replace the hashtag tip with a story-specific version
    // L13: locate the hashtag tip and posting-time tip by PATTERN, not
    // position — reordering any genre's TIPS array previously mis-targeted
    // the injection silently.
    const hashtagIdx = tips.findIndex((t) => t.includes('#'));
    if (hashtagIdx >= 0) {
      const allTags = tips[hashtagIdx]!.match(/#[a-z0-9_]+/gi) ?? [];
      tips[hashtagIdx] = [...allTags, tag].join(' ');
    }
    // Inject keyword into posting time tip
    const slotIdx = tips.findIndex((t) => /\d+\s*(?:PM|AM)\s*-\s*\d+\s*(?:PM|AM)/i.test(t));
    if (slotIdx >= 0) {
      tips[slotIdx] = `${tips[slotIdx]} — include "${keyword}" in the opening frame to ride search traffic.`;
    }
  }
  return tips;
}
