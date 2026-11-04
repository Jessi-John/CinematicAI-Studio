/**
 * Standalone healthcheck + metrics HTTP server, designed to run in a
 * separate worker thread so that even when the main thread's event
 * loop is saturated by BullMQ job processing, Docker healthchecks
 * and Prometheus scrapes still get a timely response.
 *
 * Previously the health server ran on the main thread, but event loop
 * starvation (from CPU-heavy stages like serialization, string
 * processing, and JSON parsing in the AI pipeline) caused HTTP
 * `request` events to never fire within the healthcheck's 5-second
 * timeout, making the worker appear unhealthy even while it was
 * processing jobs correctly.
 *
 * L4-WORKER-METRICS: in addition to `/health` and `/ready`, the
 * server now exposes `/metrics` so Prometheus can scrape
 * `worker:3002/metrics` and see real AI-call counts (the worker is
 * the process that makes the AI calls; the backend's metrics were
 * always 0 before this change). The metrics endpoint uses the same
 * localhost-only ACL as the backend's `/metrics` — Prometheus
 * reaches it via the Docker network because the worker's health
 * server binds to 0.0.0.0 (see `bindAddress` below).
 *
 * Usage in a worker_thread:
 *   import { Worker } from 'node:worker_threads';
 *   const healthWorker = new Worker('./dist/lib/health-server.js');
 */

import http from 'node:http';
import { metricsRequestAllowed } from '../server/metrics-acl.js';

function forbidden(res: http.ServerResponse, message: string): void {
  res.writeHead(403, { 'Content-Type': 'application/json', 'Connection': 'close' });
  res.end(JSON.stringify({ error: message }));
}

// Lazily read env vars so they are evaluated after loadEnvFiles() completes.
// This file is loaded as a worker thread entry point and does not go through
// validateAndLoadEnv(), but the lazy pattern prevents stale imports in non-Docker dev.
function getHealthPort(): number {
  return parseInt(process.env.WORKER_HEALTH_PORT || '3001', 10);
}

function getHealthBind(): string {
  // Default to localhost only. In Docker, set WORKER_HEALTH_BIND=0.0.0.0
  // so health checks reach this endpoint via the Docker bridge network.
  return process.env.WORKER_HEALTH_BIND || '127.0.0.1';
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // L4-WORKER-HEALTH-NETWORK: health and readiness endpoints expose process
  // metadata (uptime, pid). They must not be reachable from the public
  // internet when the worker binds to 0.0.0.0 in Docker. Apply the same
  // localhost + private-network ACL used for /metrics.
  if (url === '/health' || url === '/ready') {
    if (!metricsRequestAllowed(req.socket.remoteAddress)) {
      forbidden(res, 'Health endpoint is restricted to the docker network and localhost');
      return;
    }
  }

  // L4-WORKER-METRICS: metrics are now served by the main thread on
  // WORKER_METRICS_PORT (default 3002). This health server thread no
  // longer exports /metrics because prom-client Registries are not
  // shared across worker_thread boundaries; the counters incremented
  // in the main thread would always appear as zero here.
  if (url === '/metrics') {
    // L14: relative redirect — an absolute `http://localhost:PORT` URL
    // resolves `localhost` in the CLIENT's network namespace (wrong when
    // Prometheus scrapes from another container).
    res.writeHead(307, {
      'Location': '/metrics',
      'Content-Type': 'application/json',
      'Connection': 'close',
    });
    res.end(JSON.stringify({ error: 'Worker metrics moved to main thread', see: `/metrics on WORKER_METRICS_PORT` }));
    return;
  }

  if (url !== '/health' && url !== '/ready') {
    // L14: unknown paths get 404, not a 200 'ok'.
    res.writeHead(404, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const body = JSON.stringify({
    status: url === '/ready' ? 'ready' : 'ok',
    uptime: process.uptime(),
    pid: process.pid,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
  res.end(body);
});

// Prevent uncaught errors from crashing the health server.
server.on('error', (err: Error) => {
  process.stderr.write(`Health server error: ${err.message}\n`);
});

const port = getHealthPort();
const bindAddr = getHealthBind();
server.listen(port, bindAddr, () => {
  process.stdout.write(`Health server listening on ${bindAddr}:${port}\n`);
});
