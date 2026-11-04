# TODOS

## Pipeline / AI Quality

### Offline eval suite for prompt changes (E1 / D5)

**What:** A canned golden-output eval suite that scores story-generation quality when prompt templates change (`backend/src/lib/episode-generator.ts`, `backend/src/lib/style-packs.ts`).

**Why:** Prompt structure and retry behavior are already pinned by 16 blueprint tests, but output *quality* regressions from prompt edits are currently caught only by the stage8 runtime quality judge — that is, in production, on real generations.

**Context:** Decision D5 of the 2026-09-27 engineering review (`~/.gstack/projects/youtube/unknown-eng-review-20260927-112344.md`) chose to defer this rather than build it now: maintenance-heavy test type, quality judgments shift with model updates, and the runtime judge gates every real generation. Where to start: extend the existing blueprint test harness in `backend/src/lib/episode-generator-blueprint.test.ts` with a canned-provider mode that snapshots scored output against curated golden responses; run it as a separate opt-in script before prompt-template PRs merge, not in the default unit suite.

**Effort:** L
**Priority:** P3
**Depends on:** None
