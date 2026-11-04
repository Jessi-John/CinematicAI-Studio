import { describe, it, expect } from 'vitest';
import { runWithAIPipelineContext, __getPipelineContextForTest } from './ai-client.js';

describe('AI pipeline AsyncLocalStorage context', () => {
  it('carries jobId and abortSignal through a single async chain', async () => {
    const controller = new AbortController();
    await runWithAIPipelineContext('job-a', controller.signal, async () => {
      await Promise.resolve();
      const ctx = __getPipelineContextForTest();
      expect(ctx.jobId).toBe('job-a');
      expect(ctx.abortSignal).toBe(controller.signal);
    });
  });

  it('shares the same context across Promise.all branches', async () => {
    const controller = new AbortController();
    await runWithAIPipelineContext('job-b', controller.signal, async () => {
      const branches = await Promise.all([
        Promise.resolve().then(() => __getPipelineContextForTest().jobId),
        Promise.resolve().then(() => __getPipelineContextForTest().jobId),
        Promise.resolve().then(() => __getPipelineContextForTest().abortSignal),
      ]);
      expect(branches).toEqual(['job-b', 'job-b', controller.signal]);
    });
  });

  it('isolates concurrent pipelines so one job cannot overwrite another', async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    async function slowJob(jobId: string, signal: AbortSignal, delayMs: number) {
      return runWithAIPipelineContext(jobId, signal, async () => {
        const before = __getPipelineContextForTest();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const after = __getPipelineContextForTest();
        return { before, after };
      });
    }

    // Start job A, then immediately start job B. Job A finishes after job B.
    // With the old module-level globals, job A would see job B's context on completion.
    const resultA = slowJob('job-a', controllerA.signal, 50);
    const resultB = slowJob('job-b', controllerB.signal, 10);

    const [a, b] = await Promise.all([resultA, resultB]);

    expect(a.before.jobId).toBe('job-a');
    expect(a.after.jobId).toBe('job-a');
    expect(a.before.abortSignal).toBe(controllerA.signal);
    expect(a.after.abortSignal).toBe(controllerA.signal);

    expect(b.before.jobId).toBe('job-b');
    expect(b.after.jobId).toBe('job-b');
    expect(b.before.abortSignal).toBe(controllerB.signal);
    expect(b.after.abortSignal).toBe(controllerB.signal);
  });

  it('returns null context outside of any pipeline', () => {
    const ctx = __getPipelineContextForTest();
    expect(ctx.jobId).toBeNull();
    expect(ctx.abortSignal).toBeNull();
  });

  it('restores the outer context after a nested run completes', async () => {
    const outerController = new AbortController();
    await runWithAIPipelineContext('outer', outerController.signal, async () => {
      expect(__getPipelineContextForTest().jobId).toBe('outer');

      await runWithAIPipelineContext('inner', null, async () => {
        expect(__getPipelineContextForTest().jobId).toBe('inner');
      });

      // After nested context ends, the outer one is restored.
      expect(__getPipelineContextForTest().jobId).toBe('outer');
      expect(__getPipelineContextForTest().abortSignal).toBe(outerController.signal);
    });
  });
});
