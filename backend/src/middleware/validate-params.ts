/**
 * Request parameter validation middleware.
 *
 * Runs BEFORE CSRF middleware to ensure invalid IDs (non-UUID, non-CUID)
 * return 400 Bad Request instead of being blocked by CSRF with 403.
 *
 * Mounted ONCE at /api level before csrfMiddleware in server.ts.
 * Inspects req.path directly — no manual path registration needed.
 * Automatically handles all existing and future routes with ID params.
 */
import type { Request, Response, NextFunction } from 'express';

import { STORY_ID_REGEX } from '../lib/id-regex.js';

/**
 * Hex-character prefix pattern. A path segment that starts with 8+ hex chars
 * followed by a dash is likely a UUID. A segment starting with 'c' followed
 * by 20-28 alphanumeric chars is likely a CUID. These get validated.
 *
 * Everything else — route names ("stories", "generate"), numbers ("1", "5"),
 * short words — passes through without validation.
 */
function looksLikeUuidCandidate(segment: string): boolean {
  return /^[0-9a-f]{8,}-/i.test(segment) || /^c[0-9a-z]{20,}$/i.test(segment);
}

/**
 * Validate that any path segment that looks like a UUID or CUID actually
 * IS a valid UUID or CUID. Route names ("stories", "generate", "export"),
 * numbers ("1", "10"), and other non-ID segments pass through untouched.
 */
export function validateIdParam(req: Request, res: Response, next: NextFunction): void {
  const segments = req.path.split('/').filter(Boolean);

  for (const seg of segments) {
    if (looksLikeUuidCandidate(seg) && !STORY_ID_REGEX.test(seg)) {
      res.status(400).json({ success: false, error: 'Invalid ID format' });
      return;
    }
    // Non-candidate segments (route names, numbers, etc.) pass through
  }

  next();
}
