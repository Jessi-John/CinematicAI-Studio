/**
 * Retry utilities with proper error filtering and jittered backoff.
 */

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 511]);

export function isRetriableStatus(statusCode: number): boolean {
  return RETRIABLE_STATUS_CODES.has(statusCode);
}

export function isRetriableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('econnrefused') ||
      message.includes('aborted') ||
      // undici bodyTimeout/headersTimeout: socket destroyed by libuv
      message.includes('terminated') ||
      // undici HeadersTimeoutError / BodyTimeoutError
      message.includes('headers timeout') ||
      message.includes('body timeout') ||
      // ECONNRESET, ETIMEDOUT, ECONNABORTED, EPIPE from net stack
      message.includes('etimedout') ||
      message.includes('econnaborted') ||
      message.includes('epipe')
    ) {
      return true;
    }
  }
  return false;
}

export function calculateDelay(baseMs: number, attempt: number, capMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt);
  // M10: Apply jitter AFTER the max() so the floor is actually baseMs.
  // Previously: Math.max(baseMs, exponential) * (0.5 + Math.random()) — the
  // jitter multiplier (0.5 to 1.5) could reduce the result below baseMs, so
  // the first retry could fire after 500ms instead of the intended 1000ms floor.
  const withJitter = exponential * (0.5 + Math.random());
  return Math.min(Math.max(baseMs, withJitter), capMs);
}
