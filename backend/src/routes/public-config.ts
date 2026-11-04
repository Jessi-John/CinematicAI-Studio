/**
 * Public configuration endpoint.
 * Returns non-sensitive runtime config needed by the frontend.
 * No authentication required.
 */
import type { Request, Response, NextFunction } from 'express';
import { isRegistrationDisabled } from '../config/env.js';

const PUBLIC_GENRES = [
  'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
  'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
  'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
  'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
] as const;

const DEFAULT_GENRE = 'fantasy';
const MAX_SEED_LENGTH = 500;

export function publicConfigRouter(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/public-config') {
    res.json({
      success: true,
      data: {
        // L5: Don't expose NODE_ENV — it leaks deployment environment info.
        // The frontend doesn't need it; it has its own NEXT_PUBLIC_* vars.
        GENRES: PUBLIC_GENRES,
        DEFAULT_GENRE,
        MAX_SEED_LENGTH,
        registrationDisabled: isRegistrationDisabled(),
      },
    });
    return;
  }
  // Let other /api/* paths pass through to their respective routers.
  // Don't send a 404 here — that stops the chain and prevents e.g. /api/auth/* from matching.
  next();
}
