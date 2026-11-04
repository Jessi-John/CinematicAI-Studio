import { Router } from 'express';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { getStoryQueue, getStoryDlq, getBackgroundDlq } from '../queue/index.js';
import { registerAIMetricsHooks } from '../lib/ai-client.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

export const register = new Registry();
// L3: Collect default Node.js/OS metrics (heap, event loop lag, GC stats) by
// default. Previously only enabled when ENABLE_DEFAULT_METRICS=true, leaving
// essential runtime metrics disabled in most deployments.
if (process.env.ENABLE_DEFAULT_METRICS !== 'false') {
  collectDefaultMetrics({ register });
}

// Job metrics
export const jobsTotal = new Counter({
  name: 'cinematicai_jobs_total',
  help: 'Total number of story generation jobs',
  labelNames: ['status'] as const,
  registers: [register],
});

export const jobDuration = new Histogram({
  name: 'cinematicai_job_duration_seconds',
  help: 'Story generation job duration in seconds',
  buckets: [30, 60, 120, 180, 240, 300, 600, 900],
  registers: [register],
});

// Queue metrics — uses collect() callback to auto-populate on every /metrics scrape.
// HIGH-22: Reports all three queues (story-generation, story-generation-dlq, background-dlq)
// so operators can alert on stuck or growing queues.
export const queueDepth = new Gauge({
  name: 'cinematicai_queue_depth',
  help: 'Number of jobs waiting in each BullMQ queue',
  labelNames: ['queue'] as const,
  registers: [register],
  async collect() {
    try {
      const counts = await Promise.all([
        getStoryQueue().getWaitingCount().catch(() => 0),
        getStoryDlq().getWaitingCount().catch(() => 0),
        getBackgroundDlq().getWaitingCount().catch(() => 0),
      ]);
      this.set({ queue: 'story-generation' }, counts[0]);
      this.set({ queue: 'story-generation-dlq' }, counts[1]);
      this.set({ queue: 'background-dlq' }, counts[2]);
    } catch { /* Redis might be down during metrics scrape */ }
  },
});

// AI metrics
export const aiRequestsTotal = new Counter({
  name: 'cinematicai_ai_requests_total',
  help: 'Total AI API requests',
  labelNames: ['status', 'model'] as const,
  registers: [register],
});

export const aiRequestDuration = new Histogram({
  name: 'cinematicai_ai_request_duration_seconds',
  help: 'AI API request duration in seconds',
  labelNames: ['model'] as const,
  buckets: [1, 2, 5, 10, 15, 20, 30, 60],
  registers: [register],
});

export const aiTokensTotal = new Counter({
  name: 'cinematicai_ai_tokens_total',
  help: 'Total AI tokens consumed',
  labelNames: ['model'] as const,
  registers: [register],
});

// Wire AI client metrics callbacks
registerAIMetricsHooks({
  onRequestStart: (model) => {
    aiRequestsTotal.inc({ status: 'started', model });
  },
  onRequestSuccess: (model, durationSec, tokens) => {
    aiRequestsTotal.inc({ status: 'success', model });
    aiRequestDuration.observe({ model }, durationSec);
    if (tokens > 0) aiTokensTotal.inc({ model }, tokens);
  },
  onRequestFailure: (model) => {
    aiRequestsTotal.inc({ status: 'failure', model });
  },
});

router.get('/', asyncHandler(async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

export const metricsRouter = router;
