/**
 * Graceful shutdown infrastructure.
 *
 * Provides a shared `setupShutdown` / `runShutdown` pattern used by both
 * `server.ts` (HTTP API process) and `run-worker.ts` (BullMQ worker process).
 * Having a single implementation prevents drift between the two entry points
 * — the server and worker must shut down in the same order with the same
 * timeouts and error-handling policy.
 *
 * CONTRACT:
 *   Each entry point calls `setupGracefulShutdown(task)` to register cleanup
 *   tasks (close HTTP server, close BullMQ workers, disconnect DB, etc.).
 *   On SIGTERM/SIGINT, the registered tasks run in registration order, each
 *   with its own 15-second timeout. After all tasks complete, the process
 *   exits with code 0 on success or 1 if any task failed.
 *
 * USAGE:
 *   import { setupGracefulShutdown, registerShutdownHandlers } from './lib/graceful-shutdown.js';
 *
 *   setupGracefulShutdown(async () => { await server.close(); });
 *   registerShutdownHandlers();
 */

import type pino from 'pino';

export type ShutdownTask = () => Promise<void>;
export type CleanupResources = () => Promise<void>;

const TASK_TIMEOUT_MS = 15_000;

const shutdownTasks: ShutdownTask[] = [];
let shutdownInitiated = false;

/**
 * Register a shutdown task. Tasks run in registration order when shutdown is
 * triggered. Each task is raced against a 15-second timeout so a stuck
 * cleanup (e.g. a BullMQ worker that ignores SIGTERM) never blocks shutdown
 * past Docker's `stop_grace_period`.
 */
export function setupGracefulShutdown(task: ShutdownTask): void {
  shutdownTasks.push(task);
}

/**
 * Run all registered shutdown tasks, then call the final cleanup function.
 * Logs via the provided logger. Sets process.exitCode to 1 if any task fails.
 */
export async function runShutdown(
  signal: string,
  logger: pino.Logger,
  finalCleanup?: CleanupResources,
): Promise<void> {
  if (shutdownInitiated) return;
  shutdownInitiated = true;
  let hadError = false;
  const shutdownStart = Date.now();
  logger.info({ signal }, 'Shutdown initiated');

  for (const task of shutdownTasks) {
    try {
      await Promise.race([
        task(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn({ signal }, 'Shutdown task did not complete within 15s — continuing');
            resolve();
          }, TASK_TIMEOUT_MS).unref()
        ),
      ]);
    } catch (err) {
      hadError = true;
      logger.error({ err }, 'Shutdown task failed');
    }
  }

  if (finalCleanup) {
    try {
      await Promise.race([
        finalCleanup(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn('Final cleanup did not complete within 15s — continuing');
            resolve();
          }, TASK_TIMEOUT_MS).unref()
        ),
      ]);
    } catch (err) {
      hadError = true;
      logger.error({ err }, 'Final cleanup failed');
    }
  }

  logger.info(
    { shutdownMs: Date.now() - shutdownStart },
    'Shutdown complete'
  );

  process.exitCode = hadError ? 1 : 0;

  // Flush log buffer before exiting. pino.destination({ sync: true }) is used
  // when NODE_ENV=production, so flushing is a no-op (sync writes are already
  // flushed). In development with pino-pretty transport, call logger.flush().
  if (typeof (logger as unknown as Record<string, unknown>).flush === 'function') {
    (logger as unknown as { flush?: (cb?: () => void) => void }).flush?.();
  }

  setTimeout(() => process.exit(), 50).unref();
}

/**
 * Register SIGTERM/SIGINT handlers that trigger `runShutdown`. Call this once
 * at the entry point after all shutdown tasks have been registered.
 *
 * NOTE: BUG-002 policy — uncaught exceptions and unhandled rejections do NOT
 * trigger shutdown. A single bad request should never cascade into a full
 * process restart. These handlers only log and continue.
 */
export function registerShutdownHandlers(
  logger: pino.Logger,
  finalCleanup?: CleanupResources,
): void {
  process.on('SIGTERM', () => void runShutdown('SIGTERM', logger, finalCleanup));
  process.on('SIGINT', () => void runShutdown('SIGINT', logger, finalCleanup));
}

/**
 * Returns true once a shutdown signal has been received and `runShutdown` has
 * begun. Useful for suppressing restart loops during intentional termination.
 */
export function isShutdownInitiated(): boolean {
  return shutdownInitiated;
}
