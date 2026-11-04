/**
 * L4-WORKER-METRICS: Prometheus metrics for the worker process.
 *
 * The worker process is separate from the backend (it runs in its own
 * container, started via `node dist/queue/workers/run-worker.js`) and
 * is the process that actually issues the AI calls during a story
 * generation. Before this change, the only process that registered
 * AI metrics hooks was the backend — so the backend's Prometheus
 * counters were always 0 and the worker had no metrics at all.
 *
 * This module owns a dedicated `prom-client` Registry for the
 * worker. Counters are incremented in real time as the worker makes
 * AI calls. The registry is served by the dedicated metrics server
 * (metrics-server.ts, port 3002) with the same localhost-only ACL the
 * backend uses. Prometheus scrapes `worker:3002/metrics`
 * (defined in prometheus/prometheus.yml).
 *
 * The same `registerAIMetricsHooks` entry point that the backend
 * uses is wired here — keeping the wiring shape identical means
 * future metrics additions in `routes/metrics.ts` are a copy/paste.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const workerRegistry = new Registry();
// Always collect default node metrics — useful for diagnosing worker
// memory pressure, GC pauses, event-loop lag.
collectDefaultMetrics({ register: workerRegistry });

// L4-WORKER-METRICS: AI request counters keyed by model + status. The
// status label is one of started/success/failure so dashboards can
// compute success rate per model.
export const aiRequestsTotal = new Counter({
  name: 'cinematicai_ai_requests_total',
  help: 'Total AI API requests made by the worker',
  labelNames: ['status', 'model'] as const,
  registers: [workerRegistry],
});

export const aiRequestDuration = new Histogram({
  name: 'cinematicai_ai_request_duration_seconds',
  help: 'AI API request duration in seconds',
  labelNames: ['model'] as const,
  buckets: [1, 2, 5, 10, 15, 20, 30, 60],
  registers: [workerRegistry],
});

export const aiTokensTotal = new Counter({
  name: 'cinematicai_ai_tokens_total',
  help: 'Total AI tokens consumed by the worker',
  labelNames: ['model'] as const,
  registers: [workerRegistry],
});

// Job counters — distinct from the backend's because the worker
// owns the bull queue, not the backend. Mirrors the backend's
// shape so the same Grafana dashboard works for both.
export const jobsTotal = new Counter<'status'>({
  name: 'cinematicai_jobs_total',
  help: 'Total story generation jobs observed by the worker',
  labelNames: ['status'] as const,
  registers: [workerRegistry],
});

export const jobDuration = new Histogram<'status'>({
  name: 'cinematicai_job_duration_seconds',
  help: 'Story generation job duration in seconds',
  labelNames: ['status'] as const,
  buckets: [30, 60, 120, 180, 240, 300, 600, 900],
  registers: [workerRegistry],
});

// Attempt counters: every time a worker picks up a job it increments
// 'started'; every non-terminal failure increments 'retry'.
export const jobAttemptsTotal = new Counter<'status'>({
  name: 'cinematicai_job_attempts_total',
  help: 'Total story generation job attempts observed by the worker',
  labelNames: ['status'] as const,
  registers: [workerRegistry],
});

// Queue depth — populated by the worker itself (it owns the queues).
// Mirrors the backend's `cinematicai_queue_depth` so a single
// dashboard works against either instance.
// Uses a timer to avoid async collect() which prometheus treats as sync.
import { getStoryQueue, getStoryDlq, getBackgroundDlq } from '../../queue/index.js';
const QUEUE_DEPTH_REFRESH_MS = 30_000;
let _queueDepthCache: Array<{ queue: string; value: number }> = [
  { queue: 'story-generation', value: 0 },
  { queue: 'story-generation-dlq', value: 0 },
  { queue: 'background-dlq', value: 0 },
];

async function _refreshQueueDepth(): Promise<void> {
  try {
    const counts = await Promise.all([
      getStoryQueue().getWaitingCount().catch(() => 0),
      getStoryDlq().getWaitingCount().catch(() => 0),
      getBackgroundDlq().getWaitingCount().catch(() => 0),
    ]);
    _queueDepthCache = [
      { queue: 'story-generation', value: counts[0] },
      { queue: 'story-generation-dlq', value: counts[1] },
      { queue: 'background-dlq', value: counts[2] },
    ];
  } catch { /* Redis might be down */ }
}

// Initial refresh and periodic updates
_refreshQueueDepth();
setInterval(() => { _refreshQueueDepth(); }, QUEUE_DEPTH_REFRESH_MS).unref();

export const queueDepth = new Gauge({
  name: 'cinematicai_queue_depth',
  help: 'Number of jobs waiting in each BullMQ queue',
  labelNames: ['queue'] as const,
  registers: [workerRegistry],
  collect() {
    for (const entry of _queueDepthCache) {
      this.set({ queue: entry.queue }, entry.value);
    }
  },
});

/**
 * Wire the AI client's metrics hooks to the worker's counters.
 * Must be called once at worker startup, before any AI call. Mirrors
 * `routes/metrics.ts` so both processes export the same
 * `cinematicai_ai_*` metric family.
 */
import { registerAIMetricsHooks } from '../../lib/ai-client.js';

export function wireWorkerAIMetrics(): void {
  registerAIMetricsHooks({
    onRequestStart: (model: string) => {
      aiRequestsTotal.inc({ status: 'started', model });
    },
    onRequestSuccess: (model: string, durationSec: number, tokens: number) => {
      aiRequestsTotal.inc({ status: 'success', model });
      aiRequestDuration.observe({ model }, durationSec);
      if (tokens > 0) aiTokensTotal.inc({ model }, tokens);
    },
    onRequestFailure: (model: string) => {
      aiRequestsTotal.inc({ status: 'failure', model });
    },
  });
}
