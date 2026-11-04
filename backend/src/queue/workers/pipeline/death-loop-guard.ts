/**
 * REL-019: One-shot logger for the canned-mode + production-quality death-loop
 * misconfiguration. State lives on an instance, not at module scope, so test
 * imports get a clean copy every time.
 *
 * The death loop happens when:
 *   - STORY_TEST_MODE=canned (the canned test stories)
 *   - the configured quality_floor / grade_floor are at production-realistic
 *     values (e.g. 80 / B)
 * The canned stories score ~70 / grade C and will never pass floors like
 * 80 / B, so the job retries forever and saturates the event loop.
 *
 * The fix is two-fold:
 *   1. Emit a one-per-process warning with the exact psql commands an
 *      operator can run to fix the misconfiguration.
 *   2. Override the thresholds in-memory (DB values untouched) for this
 *      run only, so the test mode is usable.
 *
 * Tests can reset via `deathLoopGuard.__reset()` or create a fresh instance
 * with `new DeathLoopGuard()` for full isolation.
 */

import { logger } from '../../../services/logger.js';

export class DeathLoopGuard {
  private _warned = false;

  log(): void {
    if (this._warned) return;
    this._warned = true;
    logger.error(
      { storyTestMode: process.env.STORY_TEST_MODE },
      'DEATH-LOOP RISK: STORY_TEST_MODE=canned but quality thresholds appear production-realistic. ' +
        'Canned stories score ~70/grade C and will never pass floors like 80/B, causing infinite quality retries. ' +
        'Run: docker exec youtube-postgres-1 psql -U postgres -d cinematicai -c ' +
        "\"UPDATE system_settings SET value='0' WHERE key='quality_floor'; UPDATE system_settings SET value='F' WHERE key='grade_floor';\""
    );
  }

  /** Test helper: reset the one-shot flag so the warning can fire again. */
  __reset(): void {
    this._warned = false;
  }
}

/** Singleton used by the pipeline. */
export const deathLoopGuard = new DeathLoopGuard();

/**
 * Backward-compat alias so existing imports of `__resetDeathLoopGuard`
 * continue to work without changes.
 */
export function __resetDeathLoopGuard(): void {
  deathLoopGuard.__reset();
}
