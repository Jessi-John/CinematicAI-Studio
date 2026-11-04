import { Router } from 'express';
import crypto from 'node:crypto';
import { asyncHandler } from '../middleware/error.js';
import { getJobStatus } from '../queue/index.js';
import { jobsLimiter } from '../middleware/rate-limit.js';
import { subscribeToJobEvents } from '../queue/redis-pubsub.js';
import { getSharedRedis } from '../lib/shared-redis.js';
import { registerSSEConnection, unregisterSSEConnection } from '../lib/sse-dedup.js';
import type { ApiResponse } from '../services/types.js';
import { verifySSEAuth, verifySSEAuthForJob } from '../middleware/api-auth.js';
import { userOwnsJob } from '../lib/job-ownership.js';
import { getApiSecret } from '../config/env.js';
import { logger } from '../services/logger.js';
import { getPublicBaseUrl } from '../lib/request-url.js';

// LOW-20: HMAC is used as an alternative to JWT cookie auth because SSE connections
// may span across re-login boundaries. The HMAC-signed URL includes a timestamp and
// is validated server-side using API_SECRET, avoiding cookie expiry issues during
// long-running generation jobs.
const router = Router();

// 1 MB max SSE event payload — prevents memory exhaustion from malicious/correcting jobs.
const MAX_EVENT_SIZE_BYTES = 1_048_576;

// Per-connection SSE event rate limit: max 50 events/sec per SSE connection.
// Raised from 10 to 50 because the DeepSeek provider generates progress events
// at a higher rate during the 7-stage story pipeline, and dropping events would
// cause the frontend to miss intermediate progress updates. The queue mechanism
// below holds excess events and dispatches them on the next tick (setTimeout 0)
// so the client eventually receives all events even during bursts.
const SSE_EVENTS_PER_SECOND = 50;
const SSE_RATE_WINDOW_MS = 1000;

// L4-SSE-RESUME: per-job event buffer for Last-Event-ID resume support.
// Each event is LPUSH'd to a Redis list keyed `sse:buffer:{jobId}` with
// a 30-minute TTL. The list is trimmed to the most recent SSE_BUFFER_SIZE
// events so memory is bounded. On a reconnect, the new handler LRANGEs
// the list and replays any event with id > Last-Event-ID, then resumes
// the live pub/sub subscription. This is the standard SSE resume
// pattern (the browser auto-sends Last-Event-ID on EventSource
// reconnect).
const SSE_BUFFER_SIZE = 200;
const SSE_BUFFER_TTL_SECONDS = 30 * 60;

async function bufferEvent(jobId: string, eventId: number, payload: unknown): Promise<void> {
  try {
    const redis = getSharedRedis();
    const key = `sse:buffer:${jobId}`;
    const value = JSON.stringify({ id: eventId, payload });
    // LPUSH + LTRIM keeps only the most recent SSE_BUFFER_SIZE events.
    // The pipeline is atomic-ish: LPUSH first so a concurrent LRANGE
    // would either see the new event or not, never a half-written one.
    await redis.lpush(key, value);
    await redis.ltrim(key, 0, SSE_BUFFER_SIZE - 1);
    await redis.expire(key, SSE_BUFFER_TTL_SECONDS);
  } catch (err) {
    // Buffer writes are best-effort. If Redis is down, the live pub/sub
    // path still works — the client just can't resume.
    logger.warn({ jobId, err: String(err) }, 'SSE buffer write failed');
  }
}

async function readBufferedEvents(jobId: string, sinceId: number): Promise<Array<{ id: number; payload: unknown }>> {
  try {
    const redis = getSharedRedis();
    const key = `sse:buffer:${jobId}`;
    // The list is LPUSH'd (newest first). Read up to SSE_BUFFER_SIZE
    // entries and reverse to chronological order before filtering.
    const raw = await redis.lrange(key, 0, SSE_BUFFER_SIZE - 1);
    if (!raw || raw.length === 0) return [];
    const parsed: Array<{ id: number; payload: unknown }> = [];
    for (const v of raw.reverse()) {
      try {
        const o = JSON.parse(v) as { id: number; payload: unknown };
        if (typeof o.id === 'number') parsed.push(o);
      } catch {
        // Skip malformed entry — it was written by a different version
        // or got corrupted. Buffer is best-effort, not load-bearing.
      }
    }
    return parsed.filter((e) => e.id > sinceId);
  } catch (err) {
    logger.warn({ jobId, err: String(err) }, 'SSE buffer read failed');
    return [];
  }
}

router.get(
  '/:jobId/status',
  jobsLimiter,
  asyncHandler(async (req, res) => {
    const jobId = String(req.params.jobId);

    // FIX: The status endpoint must work even after the caller's JWT has
    // expired during a long generation (>15 min). We accept EITHER a valid
    // JWT (from the standard auth middleware) OR the HMAC SSE auth token
    // (returned by the POST generate endpoint as sseAuth). The HMAC auth
    // is valid for 2 hours, which covers any reasonable pipeline runtime.
    // If neither is valid, the caller gets 401 instead of a misleading 404.
    const authParam = req.query.auth;
    const tParam = req.query.t;
    if (typeof authParam === 'string' && typeof tParam === 'string') {
      // HMAC path: capability-based. The signed token is issued only to the
      // job creator (see buildSSEUrl), so possession of a valid HMAC is proof
      // of authorization — no further ownership check needed.
      const authOk = await verifySSEAuthForJob(jobId, authParam, tParam);
      if (!authOk) {
        res.status(401).json({ success: false, error: 'Invalid or expired auth' });
        return;
      }
    } else {
      // JWT path: a valid token alone must NOT expose another user's job.
      // H1: enforce that the token subject owns this jobId (fail closed).
      const user = (req as import('../middleware/jwt.js').AuthenticatedRequest).user;
      if (!user) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }
      if (!(await userOwnsJob(jobId, user.sub))) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
    }

    const status = await getJobStatus(jobId);
    res.json({ success: true, data: status } satisfies ApiResponse<typeof status>);
  })
);

// GET /:jobId/refresh-auth — issue a fresh HMAC-signed SSE URL for long-running jobs.
// Returns { sseUrl } with the new auth timestamp embedded.
router.get(
  '/:jobId/refresh-auth',
  jobsLimiter,
  asyncHandler(async (req, res) => {
    const jobId = String(req.params.jobId);
    const auth = req.query.auth;
    const t = req.query.t;

    // Verify the caller has a valid (non-expired) SSE auth — prevents refreshing for strangers.
    // Age check mirrors verifySSEAuth's TTL so this is a consistent gate.
    if (typeof auth !== 'string' || typeof t !== 'string') {
      res.status(400).json({ success: false, error: 'Missing auth parameters' });
      return;
    }
    const age = Date.now() - Number(t);
    if (age > 2 * 60 * 60 * 1000) {
      res.status(401).json({ success: false, error: 'Auth expired, restart job' });
      return;
    }

    // SECURITY: Verify the incoming signature before issuing a new URL. This prevents
    // an attacker who knows a jobId from refreshing auth without knowing the original
    // valid signature. verifySSEAuth validates the HMAC is correct for this jobId.
    const authOk = await verifySSEAuthForJob(jobId, auth, t);
    if (!authOk) {
      res.status(401).json({ success: false, error: 'Invalid auth, cannot refresh' });
      return;
    }

    const newT = Date.now();
    const sig = crypto.createHmac('sha256', getApiSecret())
      .update(`${jobId}:${newT}`)
      .digest('hex');
    // HIGH #26: Build the public URL using the trusted x-forwarded-* headers
    // from the BFF so the returned sseUrl is reachable by the browser.
    const sseUrl = `${getPublicBaseUrl(req)}/api/stories/generate/${jobId}/events?auth=${sig}&t=${newT}`;

    res.json({ success: true, data: { sseUrl } });
  })
);

// Fix HIGH-11: Guard against duplicate SSE connections for the same jobId.
// When the browser's EventSource auto-reconnects, a new HTTP connection arrives
// before the old one is fully cleaned up server-side. Without this guard, both
// connections subscribe to the same job's events, duplicating all events and
// doubling server-side resource usage.
//
// The deduplication is distributed across backend replicas via Redis pub/sub
// (see ../lib/sse-dedup.ts). Each instance keeps a local Map of active
// connections and publishes a control message when a new connection for a jobId
// is registered; other instances close their local connection for that jobId.
// If Redis is unavailable, dedup gracefully degrades to per-instance behavior.
//
// The local Map is bounded to SSE_MAX_CONNECTIONS entries to prevent unbounded
// memory growth if cleanup paths ever fail to remove entries. Entries beyond
// the limit are LRU-evicted (oldest jobId wins eviction).

router.get('/:jobId/events',
  jobsLimiter,
  (req, res, next) => {
    // Apply HMAC auth directly here (not via middleware) because the router mount
    // strips the prefix from req.path, so isSSEPath() in api-auth never matches.
    verifySSEAuth(req, res, (err) => {
      if (err) { res.status(401).json({ error: 'Unauthorized' }); return; }
      next();
    });
  },
  asyncHandler(async (req, res) => {
  const jobId = String(req.params.jobId);

  // Disable Express compression for this stream and flush headers immediately.
  // SEC-005: Explicitly disable CSP for SSE endpoint — SSE is same-origin and
  // does not load external resources; default helmet CSP could interfere.
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Per-connection SSE rate limiting with event queuing.
  // Instead of silently dropping excess events, they are queued and dispatched
  // on the next tick (setTimeout 0). This ensures the client eventually receives
  // all events even during transient bursts from fast pipeline stages, while
  // still preventing a misbehaving worker from overwhelming the connection.
  const sseEventsInWindow: number[] = [];
  const sseEventQueue: Array<unknown> = [];
  let sseDrainScheduled = false;

  function isSSEBelowRateLimit(): boolean {
    const now = Date.now();
    while (sseEventsInWindow.length > 0 && sseEventsInWindow[0]! < now - SSE_RATE_WINDOW_MS) {
      sseEventsInWindow.shift();
    }
    if (sseEventsInWindow.length >= SSE_EVENTS_PER_SECOND) {
      return false;
    }
    sseEventsInWindow.push(now);
    return true;
  }

  function drainEventQueue(): void {
    sseDrainScheduled = false;
    while (sseEventQueue.length > 0) {
      if (!isSSEBelowRateLimit()) {
        // Still rate limited — schedule another drain attempt
        if (!sseDrainScheduled) {
          sseDrainScheduled = true;
          setTimeout(drainEventQueue, SSE_RATE_WINDOW_MS / SSE_EVENTS_PER_SECOND).unref();
        }
        return;
      }
      const queued = sseEventQueue.shift() as { payload: unknown; eventId?: number } | undefined;
      if (queued !== undefined) {
        writeEvent(queued.payload, queued.eventId);
      }
    }
  }

  const writeEvent = (payload: unknown, eventId?: number): void => {
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch (serErr) {
      logger.error({ jobId, err: serErr }, 'SSE event serialization failed, dropping event');
      return;
    }
    // REL-003: Guard against memory exhaustion from oversized job events.
    if (json.length > MAX_EVENT_SIZE_BYTES) {
      const eventType = (payload as { type?: string }).type ?? 'unknown';
      if (eventType === 'progress') {
        logger.warn({ jobId, length: json.length }, 'Dropping oversized progress event');
        return;
      }
      const truncatedPayload = { ...(payload as object), data: '[truncated - event too large]' };
      try {
        json = JSON.stringify(truncatedPayload);
      } catch {
        logger.error({ jobId }, 'Failed to serialize truncated SSE event, dropping');
        return;
      }
      logger.warn({ jobId, eventType, length: json.length }, 'SSE event oversized, truncating data field');
    }
    // Extract event type from the JSON payload for the SSE `event:` field.
    // The payload always contains a `type` field (connected/progress/complete/error).
    // Per SSE spec, the `event:` field allows the client EventSource to dispatch
    // typed events (e.g. `source.addEventListener('progress', ...)`) instead of
    // relying on the generic `onmessage` handler.
    let eventType = '';
    try {
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (parsed && typeof parsed === 'object' && 'type' in (parsed as Record<string, unknown>)) {
        eventType = (parsed as Record<string, string>).type ?? '';
      }
    } catch {
      // Non-JSON payload — skip event field
    }
    // L4-SSE-RESUME: emit the `id:` field when the caller supplies an
    // eventId. The browser's EventSource uses this to set
    // Last-Event-ID on the next reconnect, which we then use to
    // replay missed events. Events sent without an id (e.g. the
    // `connected` greeting, the `heartbeat` keepalive) are still
    // emitted without an id field — that matches the SSE spec and
    // tells the browser "no resumable id here".
    const eventField = eventType ? `event: ${eventType}\n` : '';
    if (typeof eventId === 'number' && Number.isFinite(eventId)) {
      res.write(`${eventField}id: ${eventId}\ndata: ${json}\n\n`);
    } else {
      res.write(`${eventField}data: ${json}\n\n`);
    }
  };

  const send = (payload: unknown, eventId?: number): void => {
    if (isSSEBelowRateLimit()) {
      writeEvent(payload, eventId);
      return;
    }
    // Queue the event for later delivery instead of dropping it.
    // The queue is bounded at 1000 entries to prevent memory exhaustion
    // from a truly runaway worker. Events beyond the bound are dropped.
    if (sseEventQueue.length >= 1000) {
      logger.warn({ jobId, queueLength: sseEventQueue.length }, 'SSE event queue full — dropping oldest event');
      sseEventQueue.shift();
    }
    sseEventQueue.push({ payload, eventId });
    if (!sseDrainScheduled) {
      sseDrainScheduled = true;
      setTimeout(drainEventQueue, SSE_RATE_WINDOW_MS / SSE_EVENTS_PER_SECOND).unref();
    }
  };

  send({ type: 'connected', jobId });

  // L4-SSE-RESUME: read the Last-Event-ID header and replay any missed
  // events from the Redis buffer before resuming live pub/sub. The
  // header is auto-sent by the browser's EventSource on reconnect.
  // We use the header value as the "since" cursor; events with id >
  // since are replayed in chronological order. The SSE standard
  // requires the server to emit an `id:` field on each event for this
  // to work; the writer below now does that (id: ${eventId}\n).
  const lastEventIdHeader = req.headers['last-event-id'];
  const lastEventId = typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : NaN;
  let nextEventId = Number.isFinite(lastEventId) ? lastEventId + 1 : 1;
  if (Number.isFinite(lastEventId)) {
    const missed = await readBufferedEvents(jobId, lastEventId);
    if (missed.length > 0) {
      logger.info(
        { jobId, lastEventId, replayCount: missed.length },
        'L4-SSE-RESUME: replaying missed events from buffer'
      );
      for (const ev of missed) {
        send(ev.payload, ev.id);
        nextEventId = Math.max(nextEventId, ev.id + 1);
      }
    }
  }

  // Declare timer/resource variables OUTSIDE the try block so the catch block
  // and the early cleanup function can always access them by name (even when
  // subscribeToJobEvents throws before they are assigned). All are initialized
  // to undefined so the early cleanup can check for defined-ness.
  //
  // This is critical because:
  // 1. resetActivityTimeout() and setInterval(heartbeat) allocate timers BEFORE
  //    the await subscribeToJobEvents() call. If subscribeToJobEvents() throws,
  //    those timers must be cleaned up.
  // 2. If these were declared with 'let' inside the try block, they'd be scoped
  //    there and inaccessible from the catch block.
  // 3. The early cleanup no-op checks for undefined on each resource — if the
  //    throw happened before it was allocated, the check skips it.
  let activityTimeout: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let hardCeiling: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  // ACTIVITY_TIMEOUT_MS is a const that never changes — safe to define here
  // before the try block. It's used by resetActivityTimeout() which is defined
  // inside the try block for readability (it's only called during normal flow).
  const ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  // Early cleanup: a let with a no-op default that handles the case where
  // subscribeToJobEvents() throws before the full cleanup can be wired.
  // Each resource is checked for undefined before being released, so this
  // is safe to call at any point in the allocation sequence.
  let cleanup: () => void = () => {
    unregisterSSEConnection(jobId);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (activityTimeout !== undefined) clearTimeout(activityTimeout);
    if (hardCeiling !== undefined) clearTimeout(hardCeiling);
    if (unsubscribe !== undefined) { try { unsubscribe(); } catch { /* ignore */ } }
  };

  // Wrap the remaining async body in try/catch so that any error (most likely
  // subscribeToJobEvents failing due to Redis being unavailable) is caught,
  // cleanup runs, and the error is logged — preventing leaked timers.
  try {
    function resetActivityTimeout(): void {
      clearTimeout(activityTimeout);
      activityTimeout = setTimeout(() => {
        logger.warn({ jobId }, 'SSE activity timeout — no task events for 15 min, closing');
        cleanup();
        try { res.end(); } catch { /* ignore */ }
      }, ACTIVITY_TIMEOUT_MS);
    }
    // Start the timer immediately so a worker that is already dead is not masked.
    resetActivityTimeout();

    // Heartbeat every 30 seconds keeps proxies from closing idle connections.
    // It does NOT reset the activity timeout — heartbeats prove the server is
    // running, but only task events (progress/complete/error) prove the worker
    // is alive. If the worker crashes, heartbeats must not mask the silence.
    heartbeat = setInterval(() => {
      send({ type: 'heartbeat', jobId, timestamp: Date.now() });
    }, 30000);

    const subResult = await subscribeToJobEvents(
      jobId,
      (event) => {
        // L4-SSE-RESUME: every live task event gets a monotonic id
        // (per-connection) and is appended to the Redis buffer so a
        // reconnecting client with Last-Event-ID can replay it. The
        // counter starts at lastEventId+1 (or 1 on the first connect)
        // so the same event never gets two ids across reconnects.
        const eventType = (event as { type?: string }).type;
        let assignedId: number | undefined;
        if (eventType === 'progress' || eventType === 'complete' || eventType === 'error') {
          assignedId = nextEventId++;
          // Best-effort buffer write. If it fails, the live send still
          // reaches the current client — they just can't resume on
          // reconnect. (See the "buffer writes are best-effort" comment.)
          void bufferEvent(jobId, assignedId, event);
        }
        send(event, assignedId);
        // Reset the activity timer on every task event (progress/complete/error).
        // Heartbeat and connected events bypass this callback entirely.
        resetActivityTimeout();
      },
      () => {
        cleanup();
        try {
          res.end();
        } catch {
          // ignore - already closed
        }
      }
    );
    unsubscribe = subResult.unsubscribe;

    // Hard ceiling: even if activity keeps resetting (e.g. bug in the pipeline),
    // cap the connection lifetime at 2 hours to prevent resource leaks.
    const HARD_CEILING_MS = 2 * 60 * 60 * 1000;
    hardCeiling = setTimeout(() => {
      logger.warn({ jobId }, 'SSE hard ceiling reached (2 h), closing');
      cleanup();
      try { res.end(); } catch { /* ignore */ }
    }, HARD_CEILING_MS);

    // Reassign cleanup to the FULL cleanup function that closes all resources.
    // From this point forward, cleanup handles everything — timers, unsubscribe,
    // and Map entry. The early no-op is replaced.
    cleanup = (): void => {
      unregisterSSEConnection(jobId);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (activityTimeout !== undefined) clearTimeout(activityTimeout);
      if (hardCeiling !== undefined) clearTimeout(hardCeiling);
      if (unsubscribe !== undefined) { try { unsubscribe(); } catch { /* ignore */ } }
    };

    // Register in active connections so a reconnect replaces this one.
    const closeHandler = (): void => {
      unregisterSSEConnection(jobId);
      cleanup();
    };
    await registerSSEConnection(jobId, closeHandler, res);

    // Close/error handlers handle clean disconnects.
    req.on('close', closeHandler);
    req.on('error', closeHandler);
  } catch (err) {
    // If any async step (most likely subscribeToJobEvents) threw before cleanup
    // could be fully wired, run cleanup now to close any timers that were
    // allocated. The early cleanup function checks for undefined on each resource
    // (heartbeat, activityTimeout, hardCeiling, unsubscribe) so it safely handles
    // partial allocation. After cleanup, end the response and log.
    cleanup();
    logger.error({ jobId, err }, 'SSE handler error — cleaned up resources');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
}));

export const eventsRouter = router;
