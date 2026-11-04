import type { Response } from 'express';
import type { AuthenticatedRequest } from './jwt.js';
import type { ApiResponse } from '../services/types.js';

/**
 * Verify that the requesting user owns the story or is an admin.
 * After the anonymous-story migration, userId is never null; any mismatch
 * (including unauthenticated callers) is rejected with 403.
 */
export function verifyStoryOwnership(storyUserId: string, req: AuthenticatedRequest, res: Response): boolean {
  const userId = req.user?.sub;
  const role = req.user?.role;
  if (role === 'admin') return true;
  if (!userId || storyUserId !== userId) {
    res.status(403).json({ success: false, error: 'Forbidden' } satisfies ApiResponse<null>);
    return false;
  }
  return true;
}
