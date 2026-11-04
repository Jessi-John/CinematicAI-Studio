import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { stage10CopyrightSweep } from './stage10-copyright-sweep.js';
import type { StageContext, StageHelpers } from '../types.js';

const helpers = {} as StageHelpers;

function ctxWith(story: Record<string, unknown>): StageContext {
  return { jobId: 'j', requestId: 'r', story } as unknown as StageContext;
}

function baseStory(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: 'A Cold Door', characters: [], environments: [], episodes: [], ...extra };
}

function ep(synopsis: string): Record<string, unknown> {
  return { title: '', hook: '', synopsis, cliffhanger: '', scenes: [] };
}

describe('stage10CopyrightSweep', () => {
  it('redacts monetization terms in the YouTube SEO listing and does NOT throw', async () => {
    const story = baseStory({
      youtubeSeo: {
        title: 'A Gore-Filled Dawn',
        description: 'so much gore everywhere',
        tags: ['gore', 'dark'],
        hookScript: 'a massacre begins at midnight',
      },
    });
    await stage10CopyrightSweep(ctxWith(story), helpers);
    const seo = story.youtubeSeo as { title: string; description: string; tags: string[]; hookScript: string };
    expect(seo.title).not.toMatch(/gore/i);
    expect(seo.description).not.toMatch(/gore/i);
    expect(seo.tags.join(',')).not.toMatch(/gore/i);
    expect(seo.tags).toContain('dark');
    expect(seo.hookScript).not.toMatch(/massacre/i);
  });

  it('throws on hard safety violations anywhere in the story', async () => {
    const story = baseStory({ episodes: [ep('she wants cocaine badly')] });
    await expect(stage10CopyrightSweep(ctxWith(story), helpers)).rejects.toThrow(/Safety-blocked/);
  });

  it('preserves graphic-violence vocabulary in the narrative (horror stays producible)', async () => {
    const story = baseStory({ episodes: [ep('the room was full of gore after the massacre at dawn')] });
    await stage10CopyrightSweep(ctxWith(story), helpers);
    const synopsis = (story.episodes as Array<{ synopsis: string }>)[0]!.synopsis;
    expect(synopsis).toMatch(/gore/);
    expect(synopsis).toMatch(/massacre/);
  });

  it('H5: redacts copyright hits from youtubeSeo (not just the narrative)', async () => {
    const story = baseStory({
      youtubeSeo: {
        title: 'Harry Potter style adventure',
        description: 'clean description',
        tags: ['pikachu', 'anime'],
        hookScript: 'clean hook',
        ctaScript: 'clean cta',
        thumbnailSuggestions: ['naruto cosplay thumbnail'],
        trendingKeywords: ['clean keyword'],
        videoTemplate: 'clean template',
        targetAudience: 'clean audience',
        recommendedDuration: '60s',
        algorithmBoostTips: ['clean tip'],
      },
    });
    await stage10CopyrightSweep(ctxWith(story), helpers);
    const seo = story.youtubeSeo as {
      title: string; description: string; tags: string[]; hookScript: string;
      ctaScript: string; thumbnailSuggestions: string[]; trendingKeywords: string[];
    };
    expect(seo.title).not.toMatch(/harry potter/i);
    expect(seo.tags).not.toContain('pikachu');
    expect(seo.tags).toContain('anime');
    expect(seo.thumbnailSuggestions.join(',')).not.toMatch(/naruto/i);
    // A full rescan of the story must come back clean after redaction.
    const { scanObject } = await import('../../../../lib/copyright-filter.js');
    expect(scanObject(story)).toEqual([]);
  });
});
