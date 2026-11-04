import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from './jwt.js';

// The middleware uses Response.json(). Mock it.
function mockRes(): Response & { _getStatus: () => number; _getJson: () => unknown } {
  let statusCode = 200;
  let jsonData: unknown = null;
  return {
    status: (code: number) => {
      statusCode = code;
      return { json: (data: unknown) => { jsonData = data; } };
    },
    _getStatus: () => statusCode,
    _getJson: () => jsonData,
  } as unknown as Response & { _getStatus: () => number; _getJson: () => unknown };
}

describe('verifyStoryOwnership', () => {
  let verifyStoryOwnership: (storyUserId: string, req: AuthenticatedRequest, res: Response) => boolean;

  beforeAll(async () => {
    const mod = await import('./story-ownership.js');
    verifyStoryOwnership = mod.verifyStoryOwnership;
  });

  it('allows access when userId matches storyUserId', () => {
    const req = { user: { sub: 'user-123', role: 'user' } };
    const res = mockRes();
    const result = verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res);
    expect(result).toBe(true);
    expect(res._getStatus()).toBe(200);
  });

  it('rejects with 403 when userId does not match storyUserId', () => {
    const req = { user: { sub: 'user-456', role: 'user' } };
    const res = mockRes();
    const result = verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res);
    expect(result).toBe(false);
    expect(res._getStatus()).toBe(403);
  });

  it('rejects with 403 when req.user is missing', () => {
    const req = {};
    const res = mockRes();
    const result = verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res);
    expect(result).toBe(false);
    expect(res._getStatus()).toBe(403);
  });

  it('rejects with 403 when req.user.sub is missing', () => {
    const req = { user: { role: 'user' } };
    const res = mockRes();
    const result = verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res);
    expect(result).toBe(false);
    expect(res._getStatus()).toBe(403);
  });

  it('allows admin regardless of userId', () => {
    const req = { user: { sub: 'some-other-user', role: 'admin' } };
    const res = mockRes();
    const result = verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res);
    expect(result).toBe(true);
    expect(res._getStatus()).toBe(200);
  });

  it('returns 403 JSON with success: false and error: Forbidden', () => {
    const req = { user: { sub: 'user-456', role: 'user' } };
    let jsonSent: unknown = null;
    const res = {
      status: (code: number) => {
        expect(code).toBe(403);
        return { json: (data: unknown) => { jsonSent = data; } };
      },
    };
    verifyStoryOwnership('user-123', req as unknown as AuthenticatedRequest, res as unknown as Response);
    expect(jsonSent).toEqual({ success: false, error: 'Forbidden' });
  });
});
