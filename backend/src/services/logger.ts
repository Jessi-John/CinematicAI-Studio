import pino from 'pino';

// LOW #47: The logger must NOT read `LOG_LEVEL` at module-import time.
// `validateAndLoadEnv()` is the source of truth for environment values, and
// several entry points import this module only after validation. To avoid a
// fragile import-order dependency, the pino instance is built lazily on first
// access. This guarantees the validated env (or the test setup) is in place.
let _logger: pino.Logger | undefined;

function buildLogger(): pino.Logger {
  const isDev = process.env.NODE_ENV !== 'production';
  return isDev
    ? pino({
        level: process.env.LOG_LEVEL || 'warn',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
            singleLine: true,
          },
        },
        base: { pid: false, hostname: false },
        redact: {
          paths: REDACT_PATHS,
          censor: '[REDACTED]',
        },
      })
    : pino(
        {
          level: process.env.LOG_LEVEL || 'info',
          base: null,
          redact: {
            paths: REDACT_PATHS,
            censor: '[REDACTED]',
          },
        },
        pino.destination({ sync: true, fd: 1 })
      );
}

// LOW-5: Log retention — defaults to 30 days. Lazy getter evaluated after
// loadEnvFiles() completes so the env value is available. NODE_ENV is always
// set by the runtime and safe to read at module level.
export function getMaxLogAgeDays(): number {
  const parsed = parseInt(process.env.MAX_LOG_AGE || '30', 10);
  return Number.isNaN(parsed) ? 30 : parsed;
}

// Shared redaction paths. MUST include `*.passwordHash` — the previous list
// only redacted `*.password`, so a leaked User object in a log would expose
// the bcrypt hash (a credential, just slower to crack).
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.body.password',
  'req.body.inviteCode',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.secret',
  // M27: pino path `*.token` only matches depth-2 (`x.token`) — top-level and
  // compound-named secrets (webhookSecret, accessToken, clientSecret, etc.)
  // previously landed in logs in cleartext. Bare top-level paths + deeper
  // common locations added.
  'password', 'passwordHash', 'token', 'refreshToken', 'csrfToken', 'secret',
  'apiKey', 'apiKeyHeader', 'sseAuth', 'hmac', 'signature', 'inviteCode',
  'webhookSecret', 'signingSecret', 'accessToken', 'idToken', 'clientSecret', 'privateKey',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.csrfToken',
  '*.secret',
  '*.apiKey',
  '*.apiKeyHeader',
  '*.sseAuth',
  '*.hmac',
  '*.signature',
  '*.inviteCode',
  '*.webhookSecret',
  '*.accessToken',
  '*.clientSecret',
  'KIMI_API_KEY',
  'MISTRAL_API_KEY',
  'JWT_SECRET',
  'API_SECRET',
  'ADMIN_API_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'REDIS_PASSWORD',
  'ALERT_RECEIVER_TOKEN',
  'LOKI_TENANT_ID',
  'INVITE_CODE',
];

export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!_logger) {
      _logger = buildLogger();
    }
    const value = _logger[prop as keyof pino.Logger];
    if (typeof value === 'function') {
      return value.bind(_logger);
    }
    return value;
  },
  // L4: forward property writes to the underlying pino instance — previously
  // `logger.level = 'debug'` silently wrote onto the proxy's empty target.
  set(_target, prop, value) {
    if (!_logger) {
      _logger = buildLogger();
    }
    (_logger as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
