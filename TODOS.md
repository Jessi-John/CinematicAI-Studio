# TODOS

## Pipeline / AI Quality

### Offline eval suite for prompt changes

**What:** A canned golden-output eval suite that scores story-generation quality when prompt templates change (`backend/src/lib/episode-generator.ts`, `backend/src/lib/style-packs.ts`).

**Why:** Prompt structure and retry behavior are already pinned by 16 blueprint tests, but output *quality* regressions from prompt edits are currently caught only by the stage8 runtime quality judge — that is, in production, on real generations.

**Context:** Deferred during the 2026-09-27 engineering review rather than built now: maintenance-heavy test type, quality judgments shift with model updates, and the runtime judge gates every real generation. Where to start: extend the existing blueprint test harness in `backend/src/lib/episode-generator-blueprint.test.ts` with a canned-provider mode that snapshots scored output against curated golden responses; run it as a separate opt-in script before prompt-template PRs merge, not in the default unit suite.

**Effort:** L
**Priority:** P3
**Depends on:** None

## Dependency upgrades

### Clear remaining high-severity production advisories

**What:** Upgrade the dependencies whose current major versions carry high-severity advisories: Prisma 6 -> 7, Zod 3 -> 4, and the OpenTelemetry Node SDK/instrumentation packages to the fixed releases. Upgrade Vitest 3/4 -> 5 to clear the dev-tool advisory.

**Why:** `npm audit --omit=dev` still reports high-severity findings for these packages. They require major-version migrations, so they were not applied during the open-source readiness pass. CI gates backend production dependencies at critical severity, frontend production dependencies at high severity, and container images at HIGH/CRITICAL. The listed upgrades are deferred because they need coordinated breaking changes.

**Context:** The non-breaking audit fixes (Next.js 16.4.5, undici 7.30.1, and compatible transitive updates) are already applied. Start with Zod and Prisma because their advisories are in request/data paths, then migrate the OpenTelemetry packages and re-run the tracing and observability tests. Finish with Vitest 5 and update the test configuration for its breaking changes.

**Effort:** L
**Priority:** P2
**Depends on:** None
