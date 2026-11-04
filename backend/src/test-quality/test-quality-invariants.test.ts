/**
 * Meta-tests for test-quality invariants.
 *
 * These tests pin down the source-code contracts that other test files
 * describe in their comments and describe-block names. They prevent the
 * "stale comment" pattern that bit the codebase during the 2026-06-28
 * test audit (e.g., a test describe block saying `PUT /api/settings/...`
 * while the source actually registers `router.patch(...)`).
 *
 * Each test reads the actual source code and asserts that:
 *   - the route registration uses the expected HTTP verb
 *   - the documented behavior (e.g., `passOnStoreError: true`) still
 *     matches the implementation
 *   - the function being described still exists with the expected shape
 *
 * If a future change makes any of these claims stale, the meta-test
 * fails and the test descriptions MUST be updated to match.
 *
 * These tests run as part of the regular vitest suite. They have no
 * external dependencies and run in milliseconds.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');

function readSource(relativePath: string): string {
  return readFileSync(join(BACKEND_SRC, relativePath), 'utf-8');
}

function readFrontendSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

describe('Test-quality invariants — route HTTP methods', () => {
  it('settings routes use PATCH (not PUT) — pin the contract', () => {
    // The test file `routes/settings.test.ts` has describe blocks titled
    // "PATCH /api/settings/:key" and the source must register PATCH.
    // If a future refactor changes this to PUT, the test descriptions
    // would become stale. This test fails the build before that drift
    // can hide.
    const src = readSource('routes/settings.ts');
    expect(src).toMatch(/router\.patch\s*\(\s*['"`]\/:key['"`]/);
    // And the source must NOT register a PUT for the same path.
    expect(src).not.toMatch(/router\.put\s*\(\s*['"`]\/:key['"`]/);
  });

  it('user-settings routes use PUT (not PATCH) — pin the contract', () => {
    const src = readSource('routes/user-settings.ts');
    // The user-settings routes are registered as PUT, not PATCH.
    // The settings.ts routes are PATCH (separately verified above);
    // user-settings is its own router with its own contract. Pin both
    // the positive and negative so a future "fix" that flips them
    // fails the build.
    expect(src).toMatch(/router\.put\s*\(/);
    expect(src).not.toMatch(/router\.patch\s*\(/);
  });
});

describe('Test-quality invariants — rate-limit configuration', () => {
  it('passOnStoreError is !isProd (fail closed in prod, fail open in dev) — pin the contract', () => {
    // express-rate-limit v7 semantics (verified in dist/index.cjs): true =
    // log store error and ALLOW the request (fail open); false = throw
    // (fail closed). `!isProd` makes production fail closed and dev/test
    // fail open. An earlier audit misread these semantics as inverted —
    // this pin prevents that mistake from recurring.
    const src = readSource('middleware/rate-limit.ts');
    expect(src).toMatch(/passOnStoreError:\s*!isProd/);
  });

  it('exports generalLimiter with 100 req/min defaults — pin the contract', () => {
    // The matrix test asserts these defaults; pin them so a config
    // change cannot silently change the production limit.
    const src = readSource('middleware/rate-limit.ts');
    expect(src).toMatch(/windowMs:\s*60_000/);
    expect(src).toMatch(/max:\s*100/);
    expect(src).toMatch(/prefix:\s*['"`]rl:general:['"`]/);
  });
});

describe('Test-quality invariants — exported middleware names', () => {
  // The `rate-limit.matrix.test.ts` test asserts that several limiters
  // are exported from the module. If a future refactor renames any of
  // them, the test would fail. This meta-test pins the export names.
  it('rate-limit.ts exports the expected limiter names', () => {
    const src = readSource('middleware/rate-limit.ts');
    const expected = [
      'generalLimiter',
      'perUserLimiter',
      'aiLimiter',
      'loginLimiter',
      'registerLimiter',
      'sessionLimiter',
      'authLimiter',
      'exportLimiter',
      'storiesLimiter',
      'healthLimiter',
      'jobsLimiter',
    ];
    for (const name of expected) {
      expect(src).toMatch(new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${name}\\b`));
    }
  });
});

describe('Test-quality invariants — helper function exports', () => {
  // The `prisma-storage.invariants.test.ts` and `story.worker.test.ts`
  // files import several helpers from production source. If a refactor
  // moves or renames any of them, the imports break. This meta-test
  // pins the export names so the breakage is caught at a higher level
  // (lint + this test) than just "import fails on first run."
  it('pipeline/helpers.ts exports the expected function names', () => {
    const src = readSource('queue/workers/pipeline/helpers.ts');
    expect(src).toMatch(/export\s+function\s+defaultCharacterBible\b/);
    expect(src).toMatch(/export\s+function\s+defaultWorldBible\b/);
    expect(src).toMatch(/export\s+function\s+sanitizeFreeOfHits\b/);
    expect(src).toMatch(/export\s+function\s+redactStoryInPlace\b/);
  });

  it('api-auth.ts exports isSSEPath', () => {
    const src = readSource('middleware/api-auth.ts');
    expect(src).toMatch(/export\s+function\s+isSSEPath\b/);
  });

  it('prisma-storage.ts exports validateStoryInvariants and validateEmbedding', () => {
    const src = readSource('database/prisma-storage.ts');
    const validationSrc = readSource('database/prisma-storage/validation.ts');
    expect(src).toMatch(/validateStoryInvariants/);
    expect(src).toMatch(/validateEmbedding/);
    expect(validationSrc).toMatch(/export\s+function\s+validateStoryInvariants\b/);
    expect(validationSrc).toMatch(/export\s+function\s+validateEmbedding\b/);
  });

  it('episode-generator.ts exports getOpeningPhrase', () => {
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/export\s+function\s+getOpeningPhrase\b/);
  });
});

describe('Test-quality invariants — frontend test descriptions', () => {
  // The story-page tab-switch test (`app/(dashboard)/story/[id]/page.test.tsx`)
  // and the require-auth test (`lib/auth/require-auth.test.tsx`) both
  // have specific behavioral claims. This meta-test pins the source
  // code that those tests verify against.
  it('RequireAuth redirects to /login when unauthenticated', () => {
    const src = readFrontendSource('lib/auth/require-auth.tsx');
    // PAG/UX-1: RequireAuth now preserves the intended destination in the
    // `from` query parameter, so the redirect target is built as a URL object
    // rather than a literal string. Pin the push call and the /login base.
    expect(src).toMatch(/router\.push\(loginUrl\.toString\(\)\)/);
    expect(src).toMatch(/['"`]\/login['"`]/);
  });

  it('StoryPage tab buttons trigger setActiveTab', () => {
    // L4-FRONTEND-SSR split the page into a server-component wrapper
    // (`page.tsx`) and a client subcomponent (`story-detail-client.tsx`)
    // so the tab logic now lives in the client subcomponent. Pin the
    // tab labels in the subcomponent (not the server wrapper).
    const src = readFrontendSource('app/(dashboard)/story/[id]/story-detail-client.tsx');
    // The four tabs the test clicks through (Overview/Image/Video/SEO)
    // must each be wired to setActiveTab. Pin the tab labels and the
    // handler reference.
    expect(src).toContain('Overview');
    expect(src).toContain('Image Prompts');
    expect(src).toContain('Video Prompts');
    expect(src).toContain('YouTube SEO');
    expect(src).toContain('setActiveTab');
  });
});

describe('Test-quality invariants — story content contracts (L4)', () => {
  // The 2026-06-28 test audit caught several regressions that the
  // happy-path tests did not:
  //   - Episode 7 with the same title as the story
  //   - Episode 8 with the "Episode N —" positional prefix
  //   - Two characters in the same role (a second cartographer)
  //   - Word counts outside the target band (150-165 vs target 115-130)
  // These meta-tests pin the source contracts that prevent the
  // regressions from coming back. If a future change loosens the
  // band, removes the title uniqueness check, or stops passing the
  // seed to the character bible, the test fails the build before
  // the regression can reach production.
  it('episode meta prompt includes a DO-NOT-USE titles list — pin the contract', () => {
    // L4-EP-TITLE: the meta prompt must include the usedTitles list
    // so the model can avoid duplicates. If a future refactor drops
    // this, the regression "Ep 7 duplicates the story title" comes
    // back.
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/usedTitles\.map\(/);
    expect(src).toMatch(/DO NOT USE/);
  });

  it('character bible prompt accepts a seed parameter — pin the contract', () => {
    // L4-CHAR-ROLE: the character bible must receive the seed so it
    // can echo the protagonist's narrative role to the AI. Without
    // this, the bible invents a parallel supporting character with
    // the same role as the protagonist (the "Lirael, a young
    // cartographer" regression).
    const src = readSource('services/character-bible.ts');
    expect(src).toMatch(/seed\?:\s*string/);
    expect(src).toMatch(/ROLE HINT/);
  });

  it('stage3 passes the seed to generateCharacterBible — pin the wiring', () => {
    // The stage module must thread ctx.seed through to the bible so
    // the ROLE HINT actually fires. A regression here would silently
    // disable the fix.
    const src = readSource('queue/workers/pipeline/stages/stage3-character-bible.ts');
    expect(src).toMatch(/seed:\s*ctx\.seed/);
  });

  it('world bible supports multiple environments — pin the contract', () => {
    // L4-ENV-MULTI: the WorldBible type must declare an
    // `environments: Omit<Environment, "id">[]` array (not just a
    // single `environment`). A regression here would store only 1
    // environment in the DB even when the model returned 3.
    const src = readSource('services/world-bible.ts');
    expect(src).toMatch(/environments:\s*Omit<Environment,\s*['"`]id['"`]>\[\]/);
  });

  it('story builder persists all environments — pin the wiring', () => {
    // The story-builder must NOT collapse environments into a
    // one-element array. Pin the `environments` (plural) pass-through
    // so a future refactor that does `environments: [environment]`
    // fails the build.
    const src = readSource('lib/story-builder.ts');
    expect(src).toMatch(/environments,/);
  });

  it('word count target band is 121-145 for strict 50-60s duration — pin the contract', () => {
    // L4-DURATION: the word count band maps to 50-60s at 145 WPM.
    // 50s × 145 WPM ÷ 60 = 121 words minimum.
    // 60s × 145 WPM ÷ 60 = 145 words maximum.
    // Together with the scene duration clamp (10-12s), this guarantees
    // every episode lands in the 50-60s range regardless of per-scene
    // variation. Pin the bounds so a future change doesn't drift.
    const src = readSource('lib/timing.ts');
    expect(src).toMatch(/TARGET_WORDS_PER_EPISODE_MIN\s*=\s*121/);
    expect(src).toMatch(/TARGET_WORDS_PER_EPISODE_MAX\s*=\s*145/);
  });

  it('validateEpisodeTitle rejects story-title duplicates — pin the safety net', () => {
    // L4-EP-TITLE: even with the prompt-level DO-NOT-USE list, the
    // post-generation validator catches any model that ignores the
    // instruction. The validator is the safety net — it MUST be
    // wired into the meta generation path.
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/export\s+function\s+validateEpisodeTitle/);
    expect(src).toMatch(/validateEpisodeTitle\(/);
  });

  it('replaceStoryAtomically deletes the old story BEFORE creating the new one', () => {
    // The unique-constraint fix requires delete-then-create order
    // (not create-then-delete). The original code did
    // create-then-delete, which crashed with P2002 because the old
    // row was still present when the new row was inserted. Pin the
    // call order so a future refactor doesn't regress.
    const src = readSource('database/prisma-storage/write.ts');
    // Find the function body and verify the order of operations.
    // We match from the function signature up to a closing brace at
    // column 0 — the function body is the only top-level construct
    // that ends with a newline + closing brace. The lookahead is
    // a lookahead only (not consumed), so we capture up to but not
    // including the closing brace.
    const match = src.match(/export\s+async\s+function\s+replaceStoryAtomically[\s\S]*?(?:\n}\s*\n)/);
    expect(match).not.toBeNull();
    if (match) {
      const body = match[0];
      const deleteIdx = body.search(/tx\.story\.delete\(/);
      const createIdx = body.search(/tx\.story\.create\(/);
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(-1);
      expect(deleteIdx).toBeLessThan(createIdx);
    }
  });

  it('regenerateStory passes a preloadedStory to the pipeline', () => {
    // REGEN-FAST: the regenerate endpoint must pass the existing
    // story as preloadedStory so stages 1-4 are skipped via
    // isStageDone. Without this, regeneration re-runs the full
    // pipeline (~3-4 min, 100+ API calls) instead of just episodes
    // (~1 min, 70 API calls). The pin is loose (any reference to
    // preloadedStory in the call) because the property name is the
    // contract — the exact variable name could change.
    const src = readSource('services/story-regeneration.ts');
    expect(src).toMatch(/preloadedStory/);
    // And the runStoryPipeline call site must include it in the
    // options object — not just have the type defined.
    expect(src).toMatch(/runStoryPipeline\(\{[\s\S]*?preloadedStory/);
  });

  it('stage names use underscores (not hyphens) — pin the contract', () => {
    // The orchestrator's REGEN-FAST pre-load sets stage-done flags
    // with the EXACT same names the stages use. The flags must use
    // underscores because that is what `markStageDone('character_bible')`
    // and `markStageDone('world_bible')` write. Using hyphens would
    // silently fail the isStageDone check and the stage would still
    // run, breaking regeneration.
    const src = readSource('queue/workers/pipeline/orchestrator.ts');
    expect(src).toMatch(/markStageDone\(['"]character_bible['"]\)/);
    expect(src).toMatch(/markStageDone\(['"]world_bible['"]\)/);
  });

  it('metrics ACL allows private Docker ranges — pin the contract', () => {
    // L4-METRICS-NETWORK: the /metrics endpoint must be reachable
    // from inside the docker network so Prometheus can scrape it.
    // Pin the private ranges (10/8, 172.16/12, 192.168/16) plus loopback
    // so a future "tighten" change doesn't break observability.
    const src = readSource('server/metrics-acl.ts');
    expect(src).toMatch(/10\.0\.0\.0\/8/);
    expect(src).toMatch(/172\.16\.0\.0\/12/);
    expect(src).toMatch(/192\.168\.0\.0\/16/);
    expect(src).toMatch(/127\.0\.0\.0\/8/);
  });

  it('worker process wires AI metrics hooks — pin the contract', () => {
    // L4-WORKER-METRICS: the worker process must call
    // wireWorkerAIMetrics() so its AI calls are counted in
    // Prometheus. Without this, the worker is invisible to
    // monitoring even though it's the process that actually makes
    // the AI calls.
    const src = readSource('queue/workers/run-worker.ts');
    expect(src).toMatch(/wireWorkerAIMetrics\(\)/);
  });

  it('SSE handler emits id: field for task events — pin the Last-Event-ID contract', () => {
    // L4-SSE-RESUME: the SSE writer must emit `id: N` on every
    // progress/complete/error event so the browser's EventSource
    // sends Last-Event-ID on reconnect. Without this, the resume
    // path is dead code.
    const src = readSource('routes/events.ts');
    expect(src).toMatch(/\$\{eventField\}id: \$\{eventId\}/);
  });

  it('SSE route handlers use asyncHandler wrapper — pin the contract', () => {
    // All async route handlers in events.ts must be wrapped in asyncHandler
    // so that thrown errors (e.g. subscribeToJobEvents failure) are caught
    // by Express error middleware instead of becoming unhandled rejections.
    // Without asyncHandler, a thrown error in the /events handler would leak
    // the activity timeout and heartbeat interval allocated before the throw.
    //
    // This test counts the number of `asyncHandler(async (` invocations in route
    // registrations and compares it to the number of `router.get(` calls.
    // Every route must use asyncHandler — if the counts don't match, the build
    // fails and the developer must wrap the new route in asyncHandler.
    const src = readSource('routes/events.ts');
    // Count asyncHandler applied to async route functions (exclude the import
    // statement by matching `asyncHandler(async ` which is the invocation pattern)
    const asyncHandlerUses = (src.match(/asyncHandler\(async\s*\(/g) || []).length;
    // Count all route registrations (each must have an asyncHandler wrapper)
    const routeRegistrations = (src.match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
    // Every route must use asyncHandler — if someone adds a route without it,
    // the counts diverge and this test fails the build.
    expect(asyncHandlerUses).toBe(routeRegistrations);
  });

  it('SSE active connections Map is bounded by SSE_MAX_CONNECTIONS — pin the contract', () => {
    // The Map must have a size bound to prevent unbounded memory growth.
    // The bound is enforced via an SSE_MAX_CONNECTIONS constant that is
    // checked before every insert in registerSSEConnection.
    const eventsSrc = readSource('routes/events.ts');
    const dedupSrc = readSource('lib/sse-dedup.ts');
    const src = eventsSrc + '\n' + dedupSrc;
    expect(src).toMatch(/const SSE_MAX_CONNECTIONS\s*=\s*500/);
    expect(src).toMatch(/activeConnections\.size\s*>=\s*SSE_MAX_CONNECTIONS/);
  });

  it('SSE cleanup function uses let (not const) — pin the contract', () => {
    // The cleanup function must be a `let` variable (not `const`) so it can
    // be assigned a default no-op early, then reassigned to the full cleanup
    // function after all resources are allocated. If it were `const`, the
    // early no-op could never be replaced, OR it couldn't be defined until
    // all resources were allocated — making it uncallable if a throw happens
    // before its definition line.
    const src = readSource('routes/events.ts');
    expect(src).toMatch(/let cleanup:\s*\(\)\s*=>\s*void/);
    // Must NOT be const cleanup
    expect(src).not.toMatch(/const cleanup\s*=/);
  });

  it('quality stage uses an LLM judge with penalty deductions — pin the contract', () => {
    // L4-QUALITY-LLM: the production regression was a 6ms heuristic
    // being labeled as a "quality score". The fix uses
    // judgeStoryQuality (a real LLM call) and subtracts deterministic
    // penalty deductions from the LLM score. Pin the LLM-call import
    // and the penalty-deduction formula so a future refactor can't
    // silently drop the judge or the penalty logic.
    const src = readSource('queue/workers/pipeline/stages/stage8-quality.ts');
    expect(src).toMatch(/import.*judgeStoryQuality/);
    expect(src).toMatch(/import.*calculateQualityPenalties/);
    expect(src).toMatch(/llmScore - penalties\.totalPenalty/);
  });

  it('character bible stage runs concurrently with world bible — pin the contract', () => {
    // L4-ENV-MULTI: stage 3 and stage 4 must run in parallel via
    // Promise.allSettled so saving one does not block the other.
    // The orchestrator uses `Promise.allSettled([...])` to fan out
    // both stages. If a future refactor changes this to sequential
    // awaits, generation slows by ~30s.
    const src = readSource('queue/workers/pipeline/orchestrator.ts');
    expect(src).toMatch(/Promise\.allSettled\(\[\s*stage3CharacterBible/);
  });

  it('scene prompt forbids "let the moment dictate the length" (regression)', () => {
    // L4-WORD-COUNT: the previous prompt contained "Do not count
    // words or sentences mechanically — let the moment dictate the
    // length" which gave the model explicit permission to ignore
    // the word target. The rebalance was a band-aid; the root
    // cause was the prompt giving the model permission to violate
    // the target. The fix removes that permission and frames the
    // target as a hard constraint. Pin the new wording so a future
    // "soften the prompt" PR doesn't reintroduce the regression.
    const src = readSource('lib/episode-generator.ts');
    // The forbidden phrase must NOT appear anywhere.
    expect(src).not.toMatch(/let the moment dictate the length/);
    // The replacement wording must commit to a hard range.
    expect(src).toMatch(/hard range/i);
  });

  it('YOUTUBE_TITLE_MAX_LENGTH is identical in ai-client.ts and ai-client.canned.ts', () => {
    // The two files share the same constant by convention (circular dep
    // prevents a direct import). If one drifts, titles in canned test
    // mode won't match production behavior.
    const mainSrc = readSource('lib/ai-client.ts');
    const cannedSrc = readSource('lib/ai-client.canned.ts');
    const mainMatch = mainSrc.match(/const YOUTUBE_TITLE_MAX_LENGTH\s*=\s*(\d+)/);
    const cannedMatch = cannedSrc.match(/const YOUTUBE_TITLE_MAX_LENGTH\s*=\s*(\d+)/);
    expect(mainMatch).not.toBeNull();
    expect(cannedMatch).not.toBeNull();
    expect(mainMatch![1]).toBe(cannedMatch![1]);
  });

  it('validateSceneQuality rejects scenes below 10 words (not character-length)', () => {
    // L4-SCENE-LEN: the previous check was `text.length < 20` (characters),
    // allowing 3-word scenes to pass validation. The fix uses word count.
    // Pin the `wordCount(text) < 10` check so it can't drift back to
    // character-length or a different threshold without failing this test.
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/wordCount\(text\)\s*<\s*10/);
    // Must NOT have character-length checks as the primary gate
    expect(src).not.toMatch(/text\.length\s*<\s*20.*too_short/);
  });

  it('login page does not import useSearchParams (forces CSR bailout)', () => {
    // L4-LOGIN-SSR: useSearchParams forces Next.js to bail out of
    // server-rendering the entire form. The fix reads params from
    // window.location.search instead. This test bans the import so
    // a future refactor can't silently reintroduce the skeleton.
    const src = readSource('../../app/login/page.tsx');
    expect(src).not.toMatch(/import.*useSearchParams/);
  });

  it('quality score uses llmScore - penalties (not 50/50 blend)', () => {
    // L4-QUALITY-LLM: the previous 50/50 blend was replaced with
    // LLM-primary + penalty deductions. Pin the formula so a future
    // refactor can't silently revert to the inflated averaging approach.
    const src = readSource('queue/workers/pipeline/stages/stage8-quality.ts');
    expect(src).toMatch(/llmScore - penalties\.totalPenalty/);
    expect(src).not.toMatch(/0\.5 \* llmVerdict\.overallScore/);
  });

  it('pronoun consistency fix is called in stage7 humanization', () => {
    // M31+: fixPronounMismatches runs after all scene processing to
    // repair any pronouns the LLM used incorrectly despite the prompt.
    // This test ensures the call exists — removing it would silently
    // break pronoun consistency for every story.
    const src = readSource('queue/workers/pipeline/stages/stage7-humanization.ts');
    expect(src).toMatch(/fixPronounMismatches\(/);
    expect(src).toMatch(/Pronoun consistency fix applied/);
  });

  it('isStrongCliffhanger exists with multi-signal detection', () => {
    // L4-CLIFFHANGER: replaces single-regex check with 7-signal
    // deterministic detection + optional semantic LLM confirmation.
    // Pin the function name and key signals so it can't be silently
    // replaced with a trivial check.
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/export function isStrongCliffhanger/);
    expect(src).toMatch(/unresolvedVerbs/);
    expect(src).toMatch(/uncertaintyWords/);
    expect(src).toMatch(/tensionWords/);
    expect(src).toMatch(/export async function evaluateCliffhangerSemantic/);
  });

  it('pronoun fix accepts an explicit named-entity list and skips other characters', () => {
    // MEDIUM #35: the continuation pass no longer uses a heuristic that
    // misclassified proper nouns/places as character names. Instead it accepts
    // an explicit `otherNamedEntities` array and skips sentences that contain
    // one of those names. Pin the parameter and the word-boundary check so the
    // fix cannot silently regress to the heuristic.
    const src = readSource('lib/episode-generator.ts');
    expect(src).toMatch(/otherNamedEntities:\s*string\[\]\s*=\s*\[\]/);
    expect(src).toMatch(/hasOtherName\s*=\s*otherNameRegexes\.some/);
    expect(src).toMatch(/escapeRegex\(n\)/);
  });

  it('semantic cliffhanger fallback runs in stage7 when deterministic check fails', () => {
    // Two-tier guardrail: the deterministic isStrongGenreEnding (genre-aware
    // successor of isStrongCliffhanger) runs first. If it returns false,
    // evaluateCliffhangerSemantic (LLM, genre-aware) runs as backup.
    // This test pins BOTH calls so neither can be removed silently.
    const src = readSource('queue/workers/pipeline/stages/stage7-humanization.ts');
    expect(src).toMatch(/isStrongGenreEnding\(/);
    expect(src).toMatch(/evaluateCliffhangerSemantic\(/);
    expect(src).toMatch(/semanticPass/);
  });

  it('pipeline stage execution order is 1→2→3+4→5→7→8→9→10→11 with checkAborted between', () => {
    // The orchestrator must run stages in the correct sequence with abort
    // checks between every stage. If a stage is reordered or a checkAborted
    // is removed, this test fails the build.
    const src = readSource('queue/workers/pipeline/orchestrator.ts');
    // Verify the full sequential calling order. We look for the checkAborted
    // calls interspersed with stage calls in the main pipeline body.
    const orderPattern = [
      /checkAborted\(\);/,
      /stage1Uniqueness\(/,
      /checkAborted\(\);/,
      /stage2Blueprint\(/,
      /checkAborted\(\);/,
      /Promise\.allSettled\(\[/,
      /stage3CharacterBible\(/,
      /stage4WorldBible\(/,
      /checkAborted\(\);/,
      /saveInterimCandidate\(\);/,
      /checkAborted\(\);/,
      /stage5Episodes\(/,
      /checkAborted\(\);/,
      /stage7Humanization\(/,
      /checkAborted\(\);/,
      /stage8Quality\(/,
      /checkAborted\(\);/,
      /stage9Seo\(/,
      /checkAborted\(\);/,
      /stage10CopyrightSweep\(/,
      /checkAborted\(\);/,
      /stage11Embedding\(/,
    ];
    let pos = 0;
    let matchCount = 0;
    for (const pattern of orderPattern) {
      const m = src.slice(pos).match(pattern);
      expect(m).not.toBeNull();
      if (m) {
        pos += m.index! + m[0].length;
        matchCount++;
      }
    }
    expect(matchCount).toBe(orderPattern.length);
  });

  it('rebalance rewrites multiple deviant scenes in one pass (not 1-scene-per-pass)', () => {
    // L4-WORD-COUNT: the previous rebalance rewrote exactly 1
    // scene per pass, max 2 passes. When all scenes were uniformly
    // off-target, 1 rewrite could not lift the total into band.
    // The root-cause fix rewrites up to 3 scenes per pass with a
    // gap-allocated budget. Pin both the function calling itself
    // (in a loop) AND the multi-scene logic.
    const src = readSource('lib/episode-generator.ts');
    // Must NOT just pick a single scene by index — must rank by
    // distance and pick the top N.
    expect(src).toMatch(/\.sort\(\(a, b\) => b\.distance - a\.distance\)/);
    expect(src).toMatch(/scenesToRewrite/);
    expect(src).toMatch(/Math\.min\(3, Math\.max\(1, Math\.ceil\(gap \/ 15\)\)\)/);
  });
});
