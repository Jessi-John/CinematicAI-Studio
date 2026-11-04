/**
 * L4-WORKER-METRICS: Prometheus metrics HTTP server for the worker process.
 *
 * The worker's health endpoint runs in a dedicated worker_thread so Docker
 * healthchecks stay responsive even when the main thread is saturated by
 * AI pipeline work. Metrics, however, must be served from the MAIN thread
 * because prom-client counters/histograms are thread-local: the worker_thread
 * has its own Registry that never receives the increments made by AI calls
 * and BullMQ event handlers in the main thread.
 *
 * This small HTTP server binds to WORKER_METRICS_PORT (default 3002) in the
 * main worker process and exposes /metrics using the same localhost-plus-Docker
 * ACL as the backend. Prometheus scrapes worker:3002/metrics.
 */

import http from 'node:http';
import { metricsRequestAllowed } from '../../server/metrics-acl.js';
import { workerRegistry } from './worker-metrics.js';
import { getWorkerMetricsPort, getWorkerMetricsBind } from '../../config/env.js';
import { logger } from '../../services/logger.js';

export function startWorkerMetricsServer(): http.Server {
  const port = getWorkerMetricsPort();
  const bind = getWorkerMetricsBind();

  logger.info({ port, bind, envPort: process.env.WORKER_METRICS_PORT, envBind: process.env.WORKER_METRICS_BIND }, 'Worker metrics server starting in main thread');

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    if (!metricsRequestAllowed(req.socket.remoteAddress)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: 'Metrics endpoint is restricted to the docker network and localhost' }));
      return;
    }

    try {
      const body = await workerRegistry.metrics();
      res.writeHead(200, { 'Content-Type': workerRegistry.contentType, 'Connection': 'close' });
      res.end(body);
    } catch (err) {
      logger.warn({ err }, 'Worker metrics render failed');
      res.writeHead(500, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: 'metrics render failed', detail: String(err) }));
    }
  });

  server.on('error', (err: Error) => {
    logger.error({ err, port, bind }, 'Worker metrics server error');
  });

  server.on('listening', () => {
    const addr = server.address();
    logger.info({ address: addr, port, bind }, 'Worker metrics server listening in main thread');
  });

  server.listen(port, bind, () => {
    logger.info({ port, bind }, 'Worker metrics server started in main thread');
  });

  // M17: return the server so run-worker can close it during graceful
  // shutdown (previously the handle was discarded and the port stayed bound).
  return server;
}
