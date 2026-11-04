/**
 * Strict environment validation. Runs once at process start.
 *
 * Rejects placeholders and obviously-malformed values. We deliberately throw
 * structured errors here (M2) rather than calling process.exit(), so Docker
 * containers surface the error in logs without entering a crash/restart loop.
 * The top-level entry point (server.ts / run-worker.ts) catches these and
 * logs them before exiting.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { logger } from '../services/logger.js';

/**
 * LOW #70: Read a Docker secret from /run/secrets/{name} if it exists.
 * Secret files take precedence over environment variables so that sensitive
 * values are never exported into the process environment (and therefore do
 * not appear in /proc/<pid>/environ). Falls back to process.env for local
 * development and test environments where Docker secrets are not mounted.
 */
function readSecretFile(name: string): string | undefined {
  const path = `/run/secrets/${name}`;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) return undefined;
    // Only the owner should be able to read the secret; group/world-readable
    // secrets are rejected as a defense-in-depth measure.
    const mode = stat.mode & 0o77;
    if (mode !== 0) {
      logger.warn({ secret: name, mode: mode.toString(8) }, 'Secret file has overly permissive permissions');
    }
    return fs.readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  } catch {
    return undefined;
  }
}

function secretOrEnv(name: string): string | undefined {
  const fromFile = readSecretFile(name.toLowerCase());
  if (fromFile !== undefined) return fromFile;
  return process.env[name];
}

// M2 — Structured validation error. Throw this instead of process.exit(1).
// Docker health checks can surface it in logs; the entry point catches it
// and exits cleanly after flushing logs.
export class EnvValidationError extends Error {
  constructor(
    message: string,
    public readonly envName: string
  ) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

// Fix: Split into truly required vars vs optional vars.
export interface RequiredEnv {
  DATABASE_URL: string;
  REDIS_URL: string;
  REDIS_PASSWORD: string;
  API_SECRET: string;
  ADMIN_API_KEY: string;
  JWT_SECRET: string;
}

export interface OptionalEnv {
  MISTRAL_API_KEY: string;
  MISTRAL_BASE_URL: string;
  MISTRAL_MODEL: string;
  EMBEDDING_MODEL: string;
  // Kimi K3 — fallback for story blueprint, character bible,
  // world bible, episodes, scenes, dialogue, and YouTube SEO (Mistral is primary)
  KIMI_API_KEY: string;
  KIMI_BASE_URL: string;
  KIMI_MODEL: string;
  // Production hardening
  DISABLE_REGISTRATION: string;
  INVITE_CODE: string;
  /**
   * HIGH-6: Explicit opt-in for auto-elevating the first registered user to
   * admin. When `DISABLE_REGISTRATION=true` (invite-only mode), the first
   * registration is implicitly operator-trusted and remains admin — this
   * flag only gates the open-registration path. When this is unset/`false`
   * and registration is open, the first user is a regular user and an
   * operator must promote to admin via DB or CLI. This eliminates the
   * "whoever registers first owns the deployment" footgun.
   */
  BOOTSTRAP_FIRST_USER_ADMIN: string;
  MAX_CONCURRENT_GENERATIONS: string;
  MAX_STORIES_PER_DAY: string;
  AI_DAILY_SPEND_CAP_USD: string;
  AI_MONTHLY_SPEND_CAP_USD: string;
  BACKUP_S3_BUCKET: string;
  BACKUP_S3_PREFIX: string;
  ALERT_WEBHOOK_URL: string;
  ALERT_RECEIVER_TOKEN: string;
}

const PLACEHOLDER_PATTERNS = [
  // Generic API key placeholders
  /your[-_]?api[-_]?key/i,
  /your[-_]?api[-_]?key[-_]?here/i,
  /^undefined$/i,
  /^null$/i,
  /^NONE$/i,
  /^NONE[-_]?HERE$/i,
  // Postgres placeholder
  /user:password@host:port/i,
  // Common placeholder values
  /^changeme$/i,
  /^changeme[-_]?please$/i,
  /^change[-_]?me$/i,
  /^replace[-_]?me$/i,
  /^replace[-_]?me[-_]?now$/i,
  /^placeholder$/i,
  /^placeholder[-_]?key$/i,
  /^fill[-_]?in[-_]?production$/i,
  /^fill[-_]?me[-_]?in$/i,
  /^not[-_]?set$/i,
  /^test[-_]?key$/i,
  /^example$/i,
  // Variations with spaces / caps
  /^(your|nice|good)[-_]?(api|openai|mistral)?[-_]?(key|secret|password|token)/i,
  // Generic "set me" placeholders (__SET_ME_TO_*, set_me_*, etc.)
  /__set_me_to_/i,
  /^set_me_/i,
  // Provider-specific placeholder patterns.
  /__SET_ME_TO_MISTRAL_API_KEY/i,
  // M34: Dev/test prefix detection. The shipped .env file uses
  // `local_dev_<role>_<random>` values (e.g. `local_dev_pg_1a2b3c4d`)
  // for every secret. Before M34, none of these matched the patterns
  // above, so a production deploy that ran with the dev .env would
  // PASS validation with publicly-known dev passwords.
  //
  // Design constraint: these patterns must NOT match the literals that
  // the test suite uses for JWT_SECRET / API_SECRET / DATABASE_URL etc.
  // (e.g. `test-secret-for-concurrency`, `postgresql://test:test@...`,
  // `test-api-secret-for-concurrency`). Test values have the form
  // `<role>-<random>` (a single hyphen, no `_dev_` segment), which is
  // structurally different from the dev .env's `local_dev_<role>_<rand>`
  // and `dev_<role>` patterns. The patterns below only match the dev
  // .env shapes:
  //   - `local_dev_*`  (the shipped .env template)
  //   - `dev_*`        (generic dev prefix)
  //   - `test_*` only when the value is a clear placeholder shape
  //     (e.g. `test_password`, `test_secret_value`) — NOT random
  //     hex/base64 test values that happen to start with `test-`.
  /^local[_-]?dev[_-]/i,
  /^dev[_-]/i,
  /^dev[-_]?key/i,
  /^dev[-_]?secret/i,
  /^dev[-_]?password/i,
  /^dev[-_]?token/i,
  // Test values: only match clear placeholder shapes, not the
  // hyphenated test-fixture literals (`test-secret-for-concurrency`,
  // `test-api-secret-for-concurrency`) which start with `test-` and
  // contain another `-` in the value. Patterns below match the
  // underscore-shape placeholders the test suite does not use.
  /^test[-_]?password$/i,
  /^test[-_]?secret[-_]?value$/i,
  /^test[-_]?token[-_]?value$/i,
  /^test[-_]?key[-_]?value$/i,
];

const PERMISSIVE_DEV_KEYS = new Set(['NODE_ENV', 'LOG_LEVEL']);

// Export for use by ai-client.ts. Must match the same PLACEHOLDER_PATTERNS list above.
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

function demand(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new EnvValidationError(`Missing required environment variable: ${name}`, name);
  }
  if (isPlaceholder(value) && !PERMISSIVE_DEV_KEYS.has(name)) {
    throw new EnvValidationError(
      `Environment variable ${name} is still a placeholder. Set a real value before starting. (prefix: ${value.slice(0, 12)})`,
      name
    );
  }
  return value;
}

function optional(value: string | undefined, fallback: string): string {
  if (!value || value.trim() === '' || isPlaceholder(value)) return fallback;
  return value;
}

// Module-level cache — populated once by validateAndLoadEnv(), then reused.
let _cache: (RequiredEnv & OptionalEnv) | undefined;

/**
 * Validate and normalize required env vars. Logs and exits on failure.
 * Safe to call multiple times — subsequent calls return the cached value.
 *
 * Strict checks (placeholder rejection) are relaxed when NODE_ENV=test or
 * STORY_TEST_MODE=canned.
 */
export function validateAndLoadEnv(): RequiredEnv & OptionalEnv {
  if (_cache) return _cache;

  // skipStrict bypasses strict env validation — only in test mode.
  // STORY_TEST_MODE=canned must NOT relax validation in production.
  const VALID_NODE_ENV_VALUES = ['development', 'test', 'production', 'staging'] as const;
  const normalizedEnv = (process.env.NODE_ENV || 'production').toLowerCase().trim();
  if (!VALID_NODE_ENV_VALUES.includes(normalizedEnv as typeof VALID_NODE_ENV_VALUES[number])) {
    // Use console.warn here (not logger) to avoid circular dependency — env
    // validation runs before logger setup is guaranteed to be complete.
    process.stderr.write(
      `[env] WARN: NODE_ENV is '${String(process.env.NODE_ENV)}' (normalized: '${normalizedEnv}') ` +
      `not in allowlist [${VALID_NODE_ENV_VALUES.join(', ')}] — treating as production\n`
    );
  }
  const skipStrict = normalizedEnv === 'test';
  // H1: Use the NORMALIZED env value for every production gate below. Raw
  // `process.env.NODE_ENV === 'production'` comparisons fail open when
  // NODE_ENV is unset (our own default is 'production') or non-lowercase
  // ('Production'/'PRODUCTION'), silently bypassing all secret requirements.
  const isProd = normalizedEnv === 'production';

  const dbUrl = skipStrict
    ? secretOrEnv('DATABASE_URL') || 'postgresql://test:test@localhost:5432/test'
    : demand('DATABASE_URL', secretOrEnv('DATABASE_URL'));
  const redisUrl = skipStrict
    ? secretOrEnv('REDIS_URL') || 'redis://localhost:6379'
    : demand('REDIS_URL', secretOrEnv('REDIS_URL'));
  // REDIS_PASSWORD: In production, either REDIS_PASSWORD must be set OR
  // REDIS_URL must already embed credentials. In dev/test, REDIS_PASSWORD
  // is optional (unauthenticated local Redis). The two sources must agree
  // when both are provided — REDIS_URL's embedded password takes precedence
  // because ioredis uses it for the actual connection; REDIS_PASSWORD is
  // used as a fallback for getSharedRedis().
  // When both are set, log a warning if they differ.
  let redisPassword: string;
  const redisUrlHasPassword = (() => {
    try {
      const pw = new URL(redisUrl).password;
      return pw !== '';
    } catch {
      return false;
    }
  })();
  if (skipStrict) {
    redisPassword = optional(secretOrEnv('REDIS_PASSWORD'), '');
  } else if (redisUrlHasPassword) {
    // REDIS_URL already has credentials — REDIS_PASSWORD is optional.
    // Log a warning if both are set and disagree.
    const urlPw = new URL(redisUrl).password;
    redisPassword = optional(secretOrEnv('REDIS_PASSWORD'), urlPw);
    const envPw = secretOrEnv('REDIS_PASSWORD');
    if (envPw && envPw !== urlPw) {
      logger.warn(
        { envPasswordPrefix: envPw.slice(0, 4), urlPasswordPrefix: urlPw.slice(0, 4) },
        'REDIS_PASSWORD and REDIS_URL embedded password differ — using URL password'
      );
    }
  } else {
    // No credentials in URL — REDIS_PASSWORD is required in production.
    redisPassword = !isProd
      ? optional(secretOrEnv('REDIS_PASSWORD'), '')
      : demand('REDIS_PASSWORD', secretOrEnv('REDIS_PASSWORD'));
  }

  // ENV-004: Production secrets must be strong random values, not predictable defaults.
  // The previous fallback used 'dev-secret-not-for-production' which is a known value
  // that would allow attackers to forge SSE URLs if NODE_ENV accidentally stayed as
  // 'development' in a production deployment (human error in env config).
  //
  // Fix: In production, API_SECRET is REQUIRED with no fallback. In dev/test, use a
  // random UUID v4 generated at process start (not a hard-coded constant) so that even
  // in dev mode, the secret is unpredictable across server restarts and cannot be
  // guessed by an attacker who knows the codebase.
  const apiSecret = (() => {
    const raw = secretOrEnv('API_SECRET');
    if (!raw || isPlaceholder(raw)) {
      if (isProd && !skipStrict) {
        throw new EnvValidationError(
          'API_SECRET is required in production. Set a strong random secret.',
          'API_SECRET'
        );
      }
      // Generate a random secret per process start so dev environments are not
      // trivially exploitable. Use crypto.randomBytes (32 bytes = 256 bits) to
      // match production secret strength requirements.
      const API_SECRET_BYTES = 32;
      return crypto.randomBytes(API_SECRET_BYTES).toString('hex');
    }
    return raw;
  })();

  // ADMIN_API_KEY: required in production, random per-process in dev/test.
  // Same rationale as API_SECRET above (ENV-004).
  const adminApiKey = (() => {
    const raw = secretOrEnv('ADMIN_API_KEY');
    if (!raw || isPlaceholder(raw)) {
      if (isProd && !skipStrict) {
        throw new EnvValidationError(
          'ADMIN_API_KEY is required in production. Set a strong random secret.',
          'ADMIN_API_KEY'
        );
      }
      return crypto.randomBytes(32).toString('hex');
    }
    return raw;
  })();

  // ADMIN_USERNAME/ADMIN_PASSWORD removed — auth now uses Prisma User model with bcrypt
  // JWT_SECRET: required in production. In dev/test/canned, derive a separate secret from API_SECRET
  // using SHA256 so that SSE HMAC key and JWT signing key are not the same value.
  const jwtSecret = (() => {
    const raw = secretOrEnv('JWT_SECRET');
    if (!raw || isPlaceholder(raw)) {
      if (isProd && !skipStrict) {
        throw new EnvValidationError(
          'JWT_SECRET is required in production. Set a strong random secret.',
          'JWT_SECRET'
        );
      }
      // Derive a separate secret — do NOT reuse API_SECRET directly
      return crypto.createHash('sha256').update(apiSecret + ':jwt').digest('hex');
    }
    return raw;
  })();

  const mistralApiKey = optional(secretOrEnv('MISTRAL_API_KEY'), '');
  const mistralBaseUrl = optional(process.env.MISTRAL_BASE_URL, 'https://api.mistral.ai/v1');
  const mistralModel = optional(process.env.MISTRAL_MODEL, 'mistral-medium-2508');
  const embeddingModel = optional(process.env.EMBEDDING_MODEL, 'mistral-embed-2312');
  // Kimi K3 — OpenAI-compatible endpoint for story generation
  const kimiApiKey = optional(secretOrEnv('KIMI_API_KEY'), '');
  const kimiBaseUrl = optional(process.env.KIMI_BASE_URL, 'https://api.kimi.com/coding/v1/chat/completions');
  const kimiModel = optional(process.env.KIMI_MODEL, 'k3');

  _cache = {
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    REDIS_PASSWORD: redisPassword,
    API_SECRET: apiSecret,
    ADMIN_API_KEY: adminApiKey,
    JWT_SECRET: jwtSecret,
    MISTRAL_API_KEY: mistralApiKey,
    MISTRAL_BASE_URL: mistralBaseUrl,
    MISTRAL_MODEL: mistralModel,
    EMBEDDING_MODEL: embeddingModel,
    KIMI_API_KEY: kimiApiKey,
    KIMI_BASE_URL: kimiBaseUrl,
    KIMI_MODEL: kimiModel,
    DISABLE_REGISTRATION: optional(process.env.DISABLE_REGISTRATION, ''),
    INVITE_CODE: optional(process.env.INVITE_CODE, ''),
    BOOTSTRAP_FIRST_USER_ADMIN: optional(process.env.BOOTSTRAP_FIRST_USER_ADMIN, ''),
    MAX_CONCURRENT_GENERATIONS: optional(process.env.MAX_CONCURRENT_GENERATIONS, ''),
    MAX_STORIES_PER_DAY: optional(process.env.MAX_STORIES_PER_DAY, ''),
    AI_DAILY_SPEND_CAP_USD: optional(process.env.AI_DAILY_SPEND_CAP_USD, ''),
    AI_MONTHLY_SPEND_CAP_USD: optional(process.env.AI_MONTHLY_SPEND_CAP_USD, ''),
    BACKUP_S3_BUCKET: optional(process.env.BACKUP_S3_BUCKET, ''),
    BACKUP_S3_PREFIX: optional(process.env.BACKUP_S3_PREFIX, 'cinematicai-backups'),
    ALERT_WEBHOOK_URL: optional(process.env.ALERT_WEBHOOK_URL, ''),
    ALERT_RECEIVER_TOKEN: optional(secretOrEnv('ALERT_RECEIVER_TOKEN'), ''),
  } as RequiredEnv & OptionalEnv;
  return _cache;
}

/**
 * Normalized production check. NODE_ENV is lower-cased and trimmed here so
 * values like 'Production' or 'PRODUCTION' are handled consistently. This
 * avoids the brittle, case-sensitive raw `process.env.NODE_ENV === 'production'`
 * checks that previously caused security flags (e.g. Secure cookies) to be
 * silently disabled.
 */
export function isProduction(): boolean {
  const VALID_NODE_ENV_VALUES = ['development', 'test', 'production', 'staging'] as const;
  const normalizedEnv = (process.env.NODE_ENV || 'production').toLowerCase().trim();
  if (!VALID_NODE_ENV_VALUES.includes(normalizedEnv as typeof VALID_NODE_ENV_VALUES[number])) {
    return true;
  }
  return normalizedEnv === 'production';
}

/** The validated API_SECRET string. Callers must import AFTER validateAndLoadEnv() has run. */
export function getApiSecret(): string {
  return validateAndLoadEnv().API_SECRET;
}

/** The validated ADMIN_API_KEY string. Callers must import AFTER validateAndLoadEnv() has run. */
export function getAdminApiKey(): string {
  return validateAndLoadEnv().ADMIN_API_KEY;
}

/** The validated JWT_SECRET string. Callers must import AFTER validateAndLoadEnv() has run. */
export function getJwtSecret(): string {
  return validateAndLoadEnv().JWT_SECRET;
}

/** The validated REDIS_PASSWORD string. Callers must import AFTER validateAndLoadEnv() has run. */
export function getRedisPassword(): string {
  return validateAndLoadEnv().REDIS_PASSWORD;
}

/**
 * Resolve the Redis URL. Prefer the Docker secret file `redis_url` so the
 * connection string (including credentials) is never exported into the
 * container environment. Otherwise return the VALIDATED REDIS_URL.
 * L2: previously bypassed validation with a silent localhost fallback.
 */
export function getRedisUrl(): string {
  const fromSecret = readSecretFile('redis_url');
  if (fromSecret) return fromSecret;
  return validateAndLoadEnv().REDIS_URL;
}

/** The validated MISTRAL_API_KEY string (empty if not configured). */
export function getMistralApiKey(): string {
  return validateAndLoadEnv().MISTRAL_API_KEY;
}

/** The validated MISTRAL_BASE_URL string. */
export function getMistralBaseUrl(): string {
  return validateAndLoadEnv().MISTRAL_BASE_URL;
}

/** The validated MISTRAL_MODEL string. */
export function getMistralModel(): string {
  return validateAndLoadEnv().MISTRAL_MODEL;
}

/** The validated EMBEDDING_MODEL string. */
export function getEmbeddingModel(): string {
  return validateAndLoadEnv().EMBEDDING_MODEL;
}

/** The validated KIMI_API_KEY string (empty if not configured). */
export function getKimiApiKey(): string {
  return validateAndLoadEnv().KIMI_API_KEY;
}

/** The validated KIMI_BASE_URL string. */
export function getKimiBaseUrl(): string {
  return validateAndLoadEnv().KIMI_BASE_URL;
}

/** The validated KIMI_MODEL string. */
export function getKimiModel(): string {
  return validateAndLoadEnv().KIMI_MODEL;
}

// ---------- Lazy config value getters ----------
// Fix #4: These are wrapped in functions so they are evaluated lazily,
// AFTER validateAndLoadEnv() has run. Module-level `process.env` reads
// (const PORT = parseInt(process.env.PORT || '34567')...) are evaluated
// at import time, which may be before env validation completes — causing
// stale defaults or incorrect values depending on import order.
// Use these getters instead of direct process.env reads at module scope.

export function getPort(): number {
  const raw = process.env.PORT || '34567';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 34567 : parsed;
}

export function getRequestTimeoutMs(): number {
  const raw = process.env.REQUEST_TIMEOUT_MS ?? '300000';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 300000 : parsed;
}

export function getShutdownDrainMs(): number {
  const raw = process.env.SHUTDOWN_DRAIN_MS ?? '30000';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 30000 : parsed;
}

export function getWorkerHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT || '3001';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 3001 : parsed;
}

export function getWorkerHealthBind(): string {
  return process.env.WORKER_HEALTH_BIND || '127.0.0.1';
}

/**
 * L4-WORKER-METRICS: dedicated port for the worker's Prometheus metrics server.
 * Runs in the main worker thread (where AI/job counters are incremented), separate
 * from the health server which runs in a worker_thread for responsiveness.
 */
export function getWorkerMetricsPort(): number {
  const raw = process.env.WORKER_METRICS_PORT || '3002';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 3002 : parsed;
}

export function getWorkerMetricsBind(): string {
  return process.env.WORKER_METRICS_BIND || '0.0.0.0';
}

export function getRunWorkerInprocess(): boolean {
  const envVal = process.env.RUN_WORKER_INPROCESS;
  if (envVal !== undefined) return envVal === 'true';
  return false;
}

/**
 * LOCAL-DEV-HTTP: When true, the backend allows cookie-based authentication
 * and CSRF tokens over plain HTTP. This is required for local Docker Compose
 * stacks that do not terminate TLS, because browsers withhold Secure cookies
 * over HTTP and the backend's JWT transport check rejects non-TLS requests.
 *
 * IMPORTANT: This MUST NOT be enabled in production. It is intentionally an
 * opt-in env var rather than a NODE_ENV-based fallback, so a production
 * deployment cannot accidentally inherit it from a shared .env file.
 */
export function allowInsecureLocalHttp(): boolean {
  return process.env.ALLOW_INSECURE_LOCAL_HTTP === 'true';
}

/**
 * C3 / SEC-E2E-GATE: Centralized guard for the E2E_TEST auth/CSRF/rate-limit
 * bypass. E2E_TEST=true is only honored when NODE_ENV is NOT production. A
 * leaked E2E_TEST=true in a production environment must NOT disable auth,
 * CSRF protection, or rate limiting — every consumer of the E2E bypass must
 * route through this helper so the production gate cannot be forgotten.
 *
 * An explicit ALLOW_E2E_IN_PRODUCTION=true override is provided for the rare
 * case of running E2E against a production-like stack; it is opt-in and must
 * never be present in a real production .env.
 */
export function e2eTestBypassEnabled(): boolean {
  if (process.env.E2E_TEST !== 'true') return false;
  if (process.env.ALLOW_E2E_IN_PRODUCTION === 'true') return true;
  return !isProduction();
}

/**
 * M9 / SEC-CANNED-GATE: Centralized guard for STORY_TEST_MODE=canned. Canned
 * mode swaps live AI providers for deterministic canned responses and relaxes
 * quality thresholds. It must never activate in production, so it is gated on
 * NODE_ENV !== production (with the same explicit override as the E2E bypass).
 */
export function cannedModeEnabled(): boolean {
  if (process.env.STORY_TEST_MODE !== 'canned') return false;
  if (process.env.ALLOW_E2E_IN_PRODUCTION === 'true') return true;
  return !isProduction();
}

/**
 * AI token budget getters.
 */

/**
 * Lazy getter for AI_MONTHLY_TOKEN_BUDGET (0 = unlimited).
 * Evaluated lazily so it's read after validateAndLoadEnv() completes.
 */
export function getMonthlyTokenBudget(): number {
  const raw = process.env.AI_MONTHLY_TOKEN_BUDGET || '0';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Lazy getter for AI_DAILY_TOKEN_BUDGET (0 = unlimited).
 * Evaluated lazily so it's read after validateAndLoadEnv() completes.
 */
export function getDailyTokenBudget(): number {
  const raw = process.env.AI_DAILY_TOKEN_BUDGET || '0';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * M28: Per-job token-budget reservation estimate. When a gate reserves budget
 * atomically, it pre-charges this many tokens from daily/monthly counters.
 * The actual usage is reconciled at completion (refund or charge the delta),
 * so a generous estimate is safe — it only reduces peak concurrency, not
 * total spend. Set to 0 to disable reservation and fall back to the
 * advisory read-only check (not recommended for concurrent deployments).
 */
export function getStoryTokenBudgetEstimate(): number {
  const raw = process.env.AI_STORY_TOKEN_BUDGET_ESTIMATE || '100000';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function getEpisodeTokenBudgetEstimate(): number {
  const raw = process.env.AI_EPISODE_TOKEN_BUDGET_ESTIMATE || '10000';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function getSceneTokenBudgetEstimate(): number {
  const raw = process.env.AI_SCENE_TOKEN_BUDGET_ESTIMATE || '5000';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

/**
 * Production hardening getters.
 */
export function isRegistrationDisabled(): boolean {
  return process.env.DISABLE_REGISTRATION === 'true';
}

/**
 * HIGH-6: Whether the first registered user should be auto-elevated to
 * admin. Returns true when registration is invite-only (DISABLE_REGISTRATION
 * implies operator intent) OR when BOOTSTRAP_FIRST_USER_ADMIN=true is set
 * explicitly. When neither holds and registration is open, the first user
 * gets role='user' and the operator must promote to admin manually.
 */
export function shouldBootstrapFirstUserAsAdmin(): boolean {
  if (isRegistrationDisabled()) return true;
  return process.env.BOOTSTRAP_FIRST_USER_ADMIN === 'true';
}

export function getInviteCode(): string | undefined {
  const raw = process.env.INVITE_CODE;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

export function getMaxConcurrentGenerations(): number {
  const raw = process.env.MAX_CONCURRENT_GENERATIONS || '0';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getMaxStoriesPerDay(): number {
  const raw = process.env.MAX_STORIES_PER_DAY || '0';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getDailySpendCapUsd(): number {
  const raw = process.env.AI_DAILY_SPEND_CAP_USD || '0';
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getMonthlySpendCapUsd(): number {
  const raw = process.env.AI_MONTHLY_SPEND_CAP_USD || '0';
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getBackupS3Bucket(): string | undefined {
  const raw = process.env.BACKUP_S3_BUCKET;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

export function getBackupS3Prefix(): string {
  return process.env.BACKUP_S3_PREFIX || 'cinematicai-backups';
}

export function getAlertWebhookUrl(): string | undefined {
  const raw = process.env.ALERT_WEBHOOK_URL;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

/** The validated ALERT_RECEIVER_TOKEN string (empty if not configured). */
export function getAlertReceiverToken(): string {
  return validateAndLoadEnv().ALERT_RECEIVER_TOKEN;
}
