/**
 * Unit tests for background-embedding.worker.ts.
 *
 * These tests verify that the background embedding worker runs AI generation
 * inside the per-pipeline async context so that every embedding provider log
 * is attributed to the originating job id.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processEmbeddingJob } from './background-embedding.worker.js';
import type { BackgroundEmbeddingJobData } from '../index.js';

const mockUpdate = vi.fn().mockResolvedValue({});
const mockPrismaClient = {
  story: { update: mockUpdate },
};

vi.mock('../../database/prisma.js', () => ({
  prisma: () => mockPrismaClient,
}));

const capturedContexts: Array<{ jobId: string | null }> = [];

vi.mock('../../lib/embeddings.js', async () => {
  const aiClient = await vi.importActual<typeof import('../../lib/ai-client.js')>('../../lib/ai-client.js');
  return {
    generateEmbedding: vi.fn(async (): Promise<number[] | null> => {
      capturedContexts.push(aiClient.__getPipelineContextForTest());
      return [0.1, 0.2, 0.3];
    }),
  };
});

function makeJob(
  overrides?: Partial<BackgroundEmbeddingJobData> & { id?: string }
): Job<BackgroundEmbeddingJobData> {
  return {
    id: overrides && 'id' in overrides ? overrides.id : 'job-emb-123',
    data: {
      storyId: 'story-123',
      conceptText: 'story:story-123 concept',
      ...overrides,
    },
  } as Job<BackgroundEmbeddingJobData>;
}

describe('processEmbeddingJob', () => {
  it('runs generateEmbedding inside a pipeline context with the job id', async () => {
    capturedContexts.length = 0;
    mockUpdate.mockClear();

    await processEmbeddingJob(makeJob({ id: 'job-emb-123' }));

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]?.jobId).toBe('job-emb-123');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'story-123' },
        data: { embedding: [0.1, 0.2, 0.3] },
      })
    );
  });

  it('falls back to a synthetic job id when BullMQ job.id is missing', async () => {
    capturedContexts.length = 0;
    mockUpdate.mockClear();

    await processEmbeddingJob(makeJob({ id: undefined as unknown as string }));

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]?.jobId).toBe('emb-story-123');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'story-123' },
        data: { embedding: [0.1, 0.2, 0.3] },
      })
    );
  });
});
