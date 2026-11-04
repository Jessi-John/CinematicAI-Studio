/**
 * Unit tests for background-seo.worker.ts.
 *
 * These tests verify that the background SEO worker runs AI generation inside
 * the per-pipeline async context so that every provider log is attributed to
 * the originating job id.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processSeoJob } from './background-seo.worker.js';
import type { BackgroundSeoJobData } from '../index.js';
import type { YouTubeSEO } from '../../services/types.js';

const mockUpsert = vi.fn().mockResolvedValue({});
const mockPrismaClient = {
  youTubeSEO: { upsert: mockUpsert },
};

vi.mock('../../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
}));

const capturedContexts: Array<{ jobId: string | null }> = [];

vi.mock('../../lib/ai-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/ai-client.js')>('../../lib/ai-client.js');
  return {
    ...actual,
    generateYouTubeSEO: vi.fn(async (): Promise<YouTubeSEO> => {
      capturedContexts.push(actual.__getPipelineContextForTest());
      const ctx = actual.__getPipelineContextForTest();
      return {
        title: ctx.jobId ?? 'no-context',
        description: 'description',
        tags: ['anime'],
        thumbnailSuggestions: ['suggestion'],
        videoTemplate: 'template',
        hookScript: 'hook',
        algorithmBoostTips: ['tip'],
        viralPotential: 75,
        recommendedDuration: '45-60 seconds',
        targetAudience: 'audience',
        trendingKeywords: ['kw'],
        ctaScript: 'cta',
      };
    }),
  };
});

function makeJob(overrides?: Partial<BackgroundSeoJobData> & { id?: string }): Job<BackgroundSeoJobData> {
  return {
    id: overrides && 'id' in overrides ? overrides.id : 'job-seo-123',
    data: {
      storyId: 'story-123',
      storyTitle: 'Test Story',
      genre: 'fantasy',
      protagonistName: 'Hero',
      episodeHook: 'A mysterious door opens.',
      episodeCount: 5,
      ...overrides,
    },
  } as Job<BackgroundSeoJobData>;
}

describe('processSeoJob', () => {
  it('runs generateYouTubeSEO inside a pipeline context with the job id', async () => {
    capturedContexts.length = 0;
    mockUpsert.mockClear();

    await processSeoJob(makeJob({ id: 'job-seo-123' }));

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]?.jobId).toBe('job-seo-123');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storyId: 'story-123' },
        update: expect.objectContaining({ title: 'job-seo-123' }),
      })
    );
  });

  it('falls back to a synthetic job id when BullMQ job.id is missing', async () => {
    capturedContexts.length = 0;
    mockUpsert.mockClear();

    await processSeoJob(makeJob({ id: undefined as unknown as string }));

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]?.jobId).toBe('seo-story-123');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storyId: 'story-123' },
        update: expect.objectContaining({ title: 'seo-story-123' }),
      })
    );
  });
});
