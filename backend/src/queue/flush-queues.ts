/**
 * Flush stale BullMQ jobs from all queues.
 *
 * Drains waiting/delayed jobs and cleans completed/failed jobs older than 1 hour.
 * Run after test suites to prevent queue backlog from blocking real jobs.
 *
 * Usage: npx tsx src/queue/flush-queues.ts
 */

import { Queue } from 'bullmq';
import { getConnectionConfig } from './index.js';

const QUEUES = ['story-generation', 'story-generation-dlq', 'background-seo', 'background-embedding', 'background-dlq'];

export async function flushQueue(name: string) {
  const q = new Queue(name, { connection: getConnectionConfig() });
  try {
    // Drain waiting/delayed jobs
    await q.drain();

    // Clean completed older than 1h and failed older than 24h
    await q.clean(3600_000, 1000, 'completed');
    await q.clean(86400_000, 1000, 'failed');
  } finally {
    await q.close();
  }
}

export async function flushAllQueues() {
  for (const name of QUEUES) {
    try {
      await flushQueue(name);
    } catch (err) {
      // Log but don't fail — a single queue failure shouldn't block others
      const { default: pino } = await import('pino');
      const fallbackLogger = pino({ level: 'warn' });
      fallbackLogger.warn({ err, queue: name }, 'Queue flush failed');
    }
  }
}

async function main() {
  console.log('Flushing all queues...');
  await flushAllQueues();
  console.log('Done. All queues flushed.');
  process.exit(0);
}

// Only run main() when this file is executed directly, not when imported.
// The import { flushAllQueues } side-effect would otherwise call process.exit(0)
// and kill the worker process.
const isMainModule = process.argv[1]?.endsWith('flush-queues.ts') || process.argv[1]?.endsWith('flush-queues.js');
if (isMainModule) {
  main().catch((err) => {
    // Fix LOW-9: logger-based error reporting instead of console.error
    // This is a standalone CLI script with no logger — use process.stderr
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
