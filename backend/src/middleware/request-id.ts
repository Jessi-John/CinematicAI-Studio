import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../services/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    startTime: number;
  }
}

const VALID_REQUEST_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['x-request-id'];
  const headerVal = Array.isArray(raw) ? raw[0] : raw;

  req.requestId =
    headerVal && VALID_REQUEST_ID_REGEX.test(headerVal) ? headerVal : randomUUID();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.requestId);

  next();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = req.startTime;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const reqLog = logger.child({ requestId: req.requestId });
    // MEDIUM #29: Strip SSE HMAC auth tokens from request logs. The events
    // endpoint authenticates via query-string `auth` and `t` parameters;
    // logging them verbatim would write live replay tokens to disk.
    const safeUrl = (req.originalUrl ?? '').replace(/([?&])(auth|t)=[^&]*/g, '$1$2=REDACTED');
    reqLog.info({
      method: req.method,
      url: safeUrl,
      status: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}
