/**
 * Transport layer: socket-level timeouts for all outbound HTTP calls.
 *
 * The previous architecture relied on AbortController + worker_threads
 * to enforce request deadlines. That is a JS-level mechanism. When the
 * main thread event loop is saturated (e.g. two concurrent story jobs
 * each running many AI calls), the AbortSignal handler that tells
 * undici to destroy the socket is delayed, the underlying TCP socket
 * stays open (CLOSE_WAIT on the client), and fetch() never settles.
 *
 * This module installs a global undici Agent with three libuv-level
 * timeouts:
 *
 *   - connectTimeout  : time to establish the TCP+TLS connection
 *   - headersTimeout  : time to wait for response headers
 *   - bodyTimeout     : inactivity timeout for the response body
 *
 * These run inside undici's C++ code, in libuv's timer heap. They
 * destroy the underlying socket regardless of main-thread JS pressure.
 * The fetch promise is then forced to reject with `TypeError: terminated`
 * (or a similar error), and the JS-level AbortController watchdog in
 * `watchdog.ts` is still active as a defense-in-depth backstop.
 *
 * The Agent is installed as the global dispatcher, which means it
 * applies to every fetch() call in the process — no call site needs
 * to change. Connection pooling is enabled (default) with a tight
 * pipeline so we don't open excess sockets.
 *
 * Side-effect import: `import './lib/http-transport.js';` from each
 * process entry point (server.ts, run-worker.ts, benchmark scripts).
 */

import { Agent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { logger } from '../services/logger.js';

const DEFAULTS = {
  // Hard caps. These are the LAST line of defense — the JS-level
  // AbortController watchdog should fire first. If it doesn't (main
  // thread starvation), these ensure the socket is destroyed.
  //
  // REL-020: headersTimeoutMs was 20s but Kimi takes 30-60s for
  // large prompts (world bible, scene generation). 20s caused premature
  // HeadersTimeoutError that tripped the AI circuit breaker. Raised to
  // 120s — matches the per-attempt watchdog (ATTEMPT_TIMEOUT_MS = 120_000
  // in ai-client.ts) so the JS-level watchdog always wins in the normal case.
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 120_000,
  bodyTimeoutMs: 120_000,
  // Pipeline / pool tuning. We are conservative because most outbound
  // calls are sequential (story generation). 6 connections per origin
  // is enough for the small concurrent fan-out we do.
  connectionsPerOrigin: 6,
  pipelining: 1,
} as const;

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildDispatcher(): Dispatcher {
  const connectTimeout = readEnvMs('HTTP_CONNECT_TIMEOUT_MS', DEFAULTS.connectTimeoutMs);
  const headersTimeout = readEnvMs('HTTP_HEADERS_TIMEOUT_MS', DEFAULTS.headersTimeoutMs);
  const bodyTimeout = readEnvMs('HTTP_BODY_TIMEOUT_MS', DEFAULTS.bodyTimeoutMs);

  const agent = new Agent({
    connect: { timeout: connectTimeout },
    headersTimeout,
    bodyTimeout,
    // Tight connection cap. The story worker is sequential, so we
    // don't need many in-flight connections to the same origin.
    connections: DEFAULTS.connectionsPerOrigin,
    pipelining: DEFAULTS.pipelining,
    // Allow keep-alive so successful requests don't pay the
    // TCP+TLS handshake cost on every call.
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });

  logger.info(
    {
      connectTimeoutMs: connectTimeout,
      headersTimeoutMs: headersTimeout,
      bodyTimeoutMs: bodyTimeout,
      connectionsPerOrigin: DEFAULTS.connectionsPerOrigin,
    },
    'HTTP_TRANSPORT_INITIALIZED',
  );
  return agent;
}

let installed = false;

/**
 * Install the global undici dispatcher. Idempotent — calling it more
 * than once is a no-op.
 *
 * Call this ONCE from each process entry point, before any HTTP call.
 */
export function installHttpTransport(): void {
  if (installed) return;
  const dispatcher = buildDispatcher();
  setGlobalDispatcher(dispatcher);
  installed = true;
  logger.info('HTTP transport dispatcher installed (undici Agent)');
}

/**
 * Test/diagnostic helper: return the currently installed dispatcher.
 */
export function getHttpDispatcher(): Dispatcher {
  return getGlobalDispatcher();
}

/**
 * Test helper: reset module state so installHttpTransport() can be
 * called again with different options.
 */
export function __resetHttpTransportForTests(): void {
  installed = false;
}
