/**
 * Regression test for REL-008: jwtMiddleware must skip SSE paths.
 *
 * On 2026-06-06, a cold-start Docker test revealed that the SSE endpoint
 * GET /api/stories/generate/:jobId/events returned 401 because jwtMiddleware
 * (mounted at /api BEFORE the eventsRouter) rejected requests without a
 * cookie. The eventsRouter contains the HMAC-based verifySSEAuth, but the
 * request never reached it. This test pins the `isSSEPath` helper exported
 * from api-auth.ts — both jwt.ts and api-auth.ts use this same helper, so
 * any drift in the regex / path stripping will be caught here.
 */

import { describe, test, expect } from 'vitest';
import { isSSEPath } from './api-auth.js';

describe('REL-008: jwtMiddleware SSE path detection (api-auth.isSSEPath)', () => {
  test('matches SSE events path', () => {
    expect(isSSEPath('/api/stories/generate/abc-123/events')).toBe(true);
  });

  test('matches SSE events path with query string (strips ?...)', () => {
    expect(isSSEPath('/api/stories/generate/abc-123/events?auth=xyz&t=123')).toBe(true);
  });

  test('matches SSE events path with longer cuid', () => {
    expect(isSSEPath('/api/stories/generate/710724c8-4aac-4756-afbd-b268f7810ffe/events?auth=abc&t=123')).toBe(true);
  });

  test('rejects generate POST (not SSE)', () => {
    expect(isSSEPath('/api/stories/generate')).toBe(false);
  });

  test('rejects stories list', () => {
    expect(isSSEPath('/api/stories')).toBe(false);
  });

  test('rejects story detail', () => {
    expect(isSSEPath('/api/stories/abc-123')).toBe(false);
  });

  test('rejects status endpoint', () => {
    expect(isSSEPath('/api/stories/generate/abc-123/status')).toBe(false);
  });

  test('rejects refresh-auth endpoint', () => {
    expect(isSSEPath('/api/stories/generate/abc-123/refresh-auth')).toBe(false);
  });

  test('rejects empty / undefined', () => {
    expect(isSSEPath('')).toBe(false);
    expect(isSSEPath(undefined)).toBe(false);
  });
});
