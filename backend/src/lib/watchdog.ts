/**
 * Wall-clock watchdog timer using a shared Worker thread pool.
 *
 * BUG-006 / REL-006: The previous `setTimeout(...)` based timeouts in
 * `ai-client.ts` and `stage9_SEO` were JS-level timers. They are scheduled
 * on the main thread's libuv timer heap, but the callback that fires them
 * must run on the JS event loop. When the main thread's event loop is
 * saturated (e.g. by 2 concurrent jobs each running many sequential AI
 * calls), the callback never gets a chance to run. We observed jobs stuck
 * at stage 9_SEO for 2+ hours with `setTimeout(180_000)` never firing,
 * because the JS event loop was at 100% CPU and never idle.
 *
 * This watchdog runs timers in a dedicated `worker_threads.Worker` pool.
 * Each worker thread has its own JS event loop, so `setTimeout` fires
 * regardless of main-thread pressure. When a deadline elapses, the
 * worker posts a message back to the main thread, which triggers the
 * caller-supplied callback (typically an AbortController.abort()).
 *
 * L1: Previously, every call to startWatchdog created a new Worker thread
 * (up to ~300 at peak: 50 calls x 3 providers x 2 jobs). This approach
 * pools workers so that at most MAX_WORKERS threads are ever live.
 * Each pooled worker manages multiple concurrent timers via a Map,
 * eliminating per-timer Worker creation/destruction overhead.
 *
 * The watchdog measures wall-clock time with `process.hrtime.bigint()`,
 * which is monotonic and unaffected by system clock changes.
 */

import { Worker } from 'node:worker_threads';
import { logger } from '../services/logger.js';

interface WatchdogError extends Error {
  code?: string;
}

const MAX_WORKERS = 4;

interface WatchdogOptions {
  /** Hard deadline in milliseconds. */
  timeoutMs: number;
  /** Stable label for log correlation. */
  label: string;
  /** Job id for log correlation. */
  jobId?: string;
}

interface WatchdogHandle {
  /** Promise that resolves when the deadline elapses. Never rejects. */
  fired: Promise<{ elapsedMs: number; reason: 'timeout' | 'cancelled' }>;
  /** Cancel the watchdog early (e.g. on success). No-op if already fired. */
  cancel: () => void;
}

/**
 * The worker source is an ES module that manages a Map of timers.
 * Each incoming message starts a timer; cancellation messages clear
 * the entry before it fires.
 */
const WORKER_SOURCE = [
  "import { parentPort } from 'node:worker_threads';",
  "const timers = new Map();",
  "parentPort.on('message', (msg) => {",
  "  if (!msg) return;",
  "  if (msg.type === 'start') {",
  "    const { id, timeoutMs } = msg;",
  "    const startNs = process.hrtime.bigint();",
  "    const promise = new Promise((resolve) => {",
  "      timers.set(id, { timeout: setTimeout(() => {",
  "        const elapsedNs = process.hrtime.bigint() - startNs;",
  "        const elapsedMs = Number(elapsedNs / 1000000n);",
  "        timers.delete(id);",
  "        parentPort.postMessage({ type: 'fired', id, reason: 'timeout', elapsedMs, label: msg.label, jobId: msg.jobId });",
  "        resolve();",
  "      }, timeoutMs), resolve });",
  "    });",
  "    void promise;",
  "  } else if (msg.type === 'cancel') {",
  "    const entry = timers.get(msg.id);",
  "    if (entry) {",
  "      clearTimeout(entry.timeout);",
  "      timers.delete(msg.id);",
  "      entry.resolve();",
  "      parentPort.postMessage({ type: 'fired', id: msg.id, reason: 'cancelled' });",
  "    }",
  "  }",
  "});",
].join('\n');

function buildWorkerDataUrl(): string {
  return 'data:text/javascript;base64,' + Buffer.from(WORKER_SOURCE, 'utf8').toString('base64');
}

let _workerPool: Worker[] | null = null;
let _poolIndex = 0;

function getWorkerFromPool(): Worker {
  if (!_workerPool) {
    _workerPool = [];
    const url = new URL(buildWorkerDataUrl());
    for (let i = 0; i < MAX_WORKERS; i++) {
      const w = new Worker(url);
      w.unref();
      w.on('error', (err) => {
        logger.error({ err }, 'Watchdog pool worker error');
      });
      _workerPool.push(w);
    }
  }
  const worker = _workerPool[_poolIndex % _workerPool.length]!;
  _poolIndex++;
  return worker;
}

let _nextWatchdogId = 0;

/**
 * Start a wall-clock watchdog using a pooled Worker thread.
 * Returns a handle with a `fired` promise and a `cancel` function.
 */
export function startWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const startedAtNs = process.hrtime.bigint();
  const id = ++_nextWatchdogId;
  const worker = getWorkerFromPool();

  let settled = false;
  let resolveFired!: (value: { elapsedMs: number; reason: 'timeout' | 'cancelled' }) => void;
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;

  const firedPromise = new Promise<{ elapsedMs: number; reason: 'timeout' | 'cancelled' }>((resolve) => {
    resolveFired = resolve;
  });

  const messageHandler = (msg: { type: string; id: number; reason: string; elapsedMs?: number; label?: string; jobId?: string }) => {
    if (msg && msg.type === 'fired' && msg.id === id) {
      settle(msg.reason === 'cancelled' ? 'cancelled' : 'timeout');
    }
  };

  worker.on('message', messageHandler);

  function settle(reason: 'timeout' | 'cancelled'): void {
    if (settled) return;
    settled = true;
    worker.removeListener('message', messageHandler);
    const elapsed = elapsedMs();
    if (reason === 'timeout') {
      logger.warn(
        {
          label: opts.label,
          jobId: opts.jobId ?? null,
          timeoutMs: opts.timeoutMs,
          elapsedMs: Math.round(elapsed),
        },
        'WATCHDOG_FIRED'
      );
    }
    resolveFired({ elapsedMs: elapsed, reason });
  }

  worker.postMessage({
    type: 'start',
    id,
    timeoutMs: opts.timeoutMs,
    label: opts.label,
    jobId: opts.jobId ?? null,
  });

  return {
    fired: firedPromise,
    cancel: () => {
      settle('cancelled');
      try {
        worker.postMessage({ type: 'cancel', id });
      } catch {
        // worker may have already exited
      }
    },
  };
}

/**
 * Race a promise against a wall-clock watchdog. The returned promise
 * resolves with the original value if the inner promise wins, or rejects
 * with a timeout error if the watchdog wins.
 */
export async function withWallClockTimeout<T>(
  inner: Promise<T>,
  timeoutMs: number,
  label: string,
  jobId?: string
): Promise<T> {
  const wd = startWatchdog({ timeoutMs, label, ...(jobId !== undefined ? { jobId } : {}) });
  try {
    const winner = await Promise.race([
      inner.then((v) => ({ kind: 'value' as const, value: v })),
      wd.fired.then((r) =>
        r.reason === 'timeout'
          ? { kind: 'timeout' as const, elapsedMs: r.elapsedMs }
          : { kind: 'cancelled' as const }
      ),
    ]);
    if (winner.kind === 'value') return winner.value;
    if (winner.kind === 'timeout') {
      const err: WatchdogError = new Error(
        `${label} hard timeout after ${timeoutMs}ms (elapsed ${Math.round(winner.elapsedMs)}ms)`
      );
      err.code = 'WALLCLOCK_TIMEOUT';
      throw err;
    }
    return await inner;
  } finally {
    wd.cancel();
  }
}

/**
 * Create an AbortController whose abort is driven by a pooled Worker thread
 * watchdog. When the watchdog fires, the AbortController is automatically
 * aborted; when the controller is aborted for any other reason, the
 * watchdog is cancelled. This is the correct primitive for wrapping
 * `fetch` so that the request aborts on a wall-clock deadline regardless
 * of main-thread event loop starvation.
 */
export interface AbortControllerWithWatchdog {
  controller: AbortController;
  /** Resolves to the elapsed wall-clock time when the watchdog fired. */
  fired: Promise<{ elapsedMs: number; fired: boolean }>;
  cancel: () => void;
}

export function createWatchdogAbortController(
  timeoutMs: number,
  label: string,
  jobId?: string
): AbortControllerWithWatchdog {
  const controller = new AbortController();
  const wd = startWatchdog({ timeoutMs, label, ...(jobId !== undefined ? { jobId } : {}) });
  let aborted = false;
  const fired = wd.fired.then((r) => {
    if (r.reason === 'timeout' && !aborted) {
      aborted = true;
      controller.abort(
        new Error(`${label} watchdog fired after ${Math.round(r.elapsedMs)}ms`)
      );
    }
    return { elapsedMs: r.elapsedMs, fired: r.reason === 'timeout' };
  });
  controller.signal.addEventListener('abort', () => {
    if (!aborted) {
      aborted = true;
      wd.cancel();
    }
  });
  return {
    controller,
    fired,
    cancel: () => wd.cancel(),
  };
}
