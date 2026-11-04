/**
 * Invariant: SSE job-stream and /status endpoints must enforce per-user job
 * ownership on the JWT-cookie path (H1 — IDOR fix).
 *
 * Root cause: verifySSEAuth and GET /:jobId/status accepted ANY valid JWT and
 * returned the target job's stream/status without checking that the token's
 * subject actually owns the job. Because jobIds are observable, any
 * authenticated user could subscribe to another user's generation stream
 * (leaking prompts/story content) or poll its status.
 *
 * The fix: both JWT-cookie auth paths call userOwnsJob(jobId, payload.sub) and
 * fail closed (403) when the caller is not the owner or ownership cannot be
 * resolved. The HMAC path remains capability-based (the signed URL is issued
 * only to the job creator).
 *
 * This test scans the source so the ownership enforcement cannot be silently
 * removed. The behavioral lock lives in routes/events.test.ts (IDOR → 403).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('sse-ownership-invariants', () => {
  const SRC_ROOT = resolve(process.cwd(), 'src');

  it('verifySSEAuth must enforce userOwnsJob on the JWT-cookie path', () => {
    const content = readFileSync(resolve(SRC_ROOT, 'middleware/api-auth.ts'), 'utf-8');
    expect(content).toContain('userOwnsJob');
    // Fail-closed status on ownership mismatch.
    expect(content).toContain("res.status(403)");
  });

  it('GET /:jobId/status must enforce userOwnsJob on the JWT path', () => {
    const content = readFileSync(resolve(SRC_ROOT, 'routes/events.ts'), 'utf-8');
    expect(content).toContain('userOwnsJob');
  });

  it('the ownership helper must fail closed when the owner is unknown', () => {
    const content = readFileSync(resolve(SRC_ROOT, 'lib/job-ownership.ts'), 'utf-8');
    // ownerId === null → return false (never expose a job of unknown owner).
    expect(content).toMatch(/ownerId === null\)\s*return false/);
  });

  it('the worker must persist userId in the job state for post-completion auth', () => {
    const content = readFileSync(resolve(SRC_ROOT, 'queue/workers/story.worker.ts'), 'utf-8');
    // Ownership survives removeOnComplete via the 7-day job-state TTL.
    expect(content).toContain("...(userId !== undefined ? { userId } : {})");
  });
});
