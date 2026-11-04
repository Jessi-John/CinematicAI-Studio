import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../services/logger.js';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  code: string | undefined;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code ?? undefined;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  // MEDIUM #41: Route through the centralized error handler so post-response
  // observability hooks and consistent response formatting are always applied.
  next(new AppError(`Cannot ${req.method} ${req.path}`, 404, 'ROUTE_NOT_FOUND'));
};

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = req.requestId || 'unknown';

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
      requestId,
    });
    return;
  }

  // Operational errors with explicit codes.
  const code = (err as { code?: string }).code;
  if (code === 'BLACKLIST_UNAVAILABLE') {
    res.status(503).json({
      success: false,
      error: 'Authentication service temporarily unavailable',
      code,
      requestId,
    });
    return;
  }

  // Extract status/type from raw error before any branching. The properties
  // may be set by body-parser (SyntaxError status=400, PayloadTooLargeError
  // type/status=413) or by verify functions (checkJsonDepth status=413).
  const httpErr = err as Error & { type?: string; status?: number; statusCode?: number };
  const errType = httpErr.type;
  const errStatus = httpErr.status ?? httpErr.statusCode;
  // body-parser raises SyntaxError when the request body is malformed JSON.
  // Without this branch, malformed JSON surfaces as a 500 — masking the real
  // cause and breaking client error-handling that expects 400.
  if (err instanceof SyntaxError && errStatus === 400) {
    res.status(400).json({
      success: false,
      error: 'Invalid JSON in request body',
      requestId,
    });
    return;
  }
  // PayloadTooLargeError has type='PayloadTooLargeError' and status=413.
  // Also handle raw-body's 'entity.too.large' type for compatibility.
  if (errType === 'PayloadTooLargeError' || errType === 'entity.too.large' || errStatus === 413) {
    res.status(413).json({
      success: false,
      error: 'Request body too large',
      requestId,
    });
    return;
  }

  logger.error({ requestId, err, stack: err.stack }, 'Unhandled error in request');

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId,
  });
};

// Intentionally permissive: accepts Express handlers AND Jest mock functions.
export const asyncHandler = ((
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}) as (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => RequestHandler;

/**
 * Wrap an async Express middleware so rejected promises are forwarded to
 * Express's error handler instead of leaving the request hanging.
 * Without this, an unhandled throw in an async middleware (e.g. Redis
 * connection failure in jwtMiddleware) silently swallows the rejection
 * and the client hangs until timeout.
 */
export const asyncMiddleware = ((
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}) as (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => RequestHandler;
