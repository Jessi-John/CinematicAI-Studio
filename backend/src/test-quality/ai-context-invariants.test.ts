/**
 * AI context invariants.
 *
 * Every AI provider call in the backend must run inside an async pipeline
 * context (`runWithAIPipelineContext`) so that logs, metrics, and abort
 * signals are attributed to the originating job/request. This test scans
 * source files and fails if a new call site is added without context.
 *
 * Allowed patterns:
 *   - Test files (they exercise the functions directly).
 *   - Implementation files that actually contain the provider clients.
 *   - Pipeline-stage files that are known to run inside `runStoryPipeline`,
 *     which establishes the context before calling stages.
 *   - AI-helper files called exclusively from within an existing context.
 *   - Any other file that imports/uses `runWithAIPipelineContext`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globFiles } from './glob-files.js';
import { resolve } from 'node:path';

const SRC_ROOT = resolve(__dirname, '..');

const TRACKED_CALLS = [
  'generateWithMistral(',
  'callMistral(',
  'callKimi(',
  'generateWithDeepSeek(',
  'generateEmbedding(',
  'generateYouTubeSEO(',
  'callMistralEmbeddingApi(',
];

/**
 * Files that implement the AI clients or are guaranteed by architecture to
 * run inside a context established by a caller. Keep this list minimal and
 * document every entry.
 */
const ALLOWLIST = new Set<string>([
  // Core AI client implementations. The context is established here and
  // propagated to the underlying provider-specific functions.
  'src/lib/ai-client.ts',
  // Embedding client implementation. The public `generateEmbedding` is wrapped
  // by callers; internal `callMistralEmbeddingApi` reads the context via
  // `getCurrentAIPipelineJobId`.
  'src/lib/embeddings.ts',
  // Episode/scene generation helpers called only from within the pipeline or
  // from regeneration services that wrap them in context.
  'src/lib/episode-generator.ts',
  // Bible/quality helpers called only from within the pipeline context.
  'src/services/character-bible.ts',
  'src/services/world-bible.ts',
  'src/services/quality-judge.ts',
  // Refinement/seed helpers called only from pipeline/index.ts, which wraps
  // the whole execution in runWithAIPipelineContext (index.ts:595) before
  // invoking them.
  'src/lib/quality-refiner.ts',
  'src/lib/seed-evaluator.ts',
]);

/**
 * Directories whose files are known to run inside `runStoryPipeline`, which
 * wraps the entire execution in `runWithAIPipelineContext` before calling
 * any stage helpers.
 */
const PIPELINE_DIRS = ['src/queue/workers/pipeline/'];

function hasTrackedCall(content: string): boolean {
  return TRACKED_CALLS.some((call) => content.includes(call));
}

function isAllowlisted(relativePath: string): boolean {
  if (ALLOWLIST.has(relativePath)) return true;
  return PIPELINE_DIRS.some((dir) => relativePath.startsWith(dir));
}

describe('AI calls must run inside a pipeline context', () => {
  // SRC_ROOT already IS backend/src — the glob must not prepend another src/.
  const files = globFiles('**/*.ts', { cwd: SRC_ROOT });
  const offenders: string[] = [];

  // C1 self-guard: a broken glob root must fail loudly, not vacuously pass.
  it('harness sanity: the scan actually found source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const absolutePath = resolve(SRC_ROOT, file);
    const rel = `src/${file.replace(/\\/g, '/')}`;
    if (rel.endsWith('.test.ts')) continue;

    const content = readFileSync(absolutePath, 'utf8');
    if (!hasTrackedCall(content)) continue;

    if (isAllowlisted(rel)) continue;
    if (content.includes('runWithAIPipelineContext')) continue;

    offenders.push(rel);
  }

  it('has no untracked AI call sites outside a pipeline context', () => {
    expect(offenders).toEqual([]);
  });
});
