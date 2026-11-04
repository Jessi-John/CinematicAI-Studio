import { validateAndLoadEnv, isPlaceholder, shouldBootstrapFirstUserAsAdmin } from './env.js';

describe('env validator', () => {
  it('does not exit in test mode', () => {
    // Test mode injects synthetic values via setup.ts; this should always pass.
    const env = validateAndLoadEnv();
    // In test mode the validator must produce non-empty strings for the
    // required keys (setUp.ts injects synthetic values). A literal-empty
    // string would be a regression in the test-mode injection.
    expect(env.KIMI_API_KEY.length).toBeGreaterThan(0);
    expect(env.DATABASE_URL.length).toBeGreaterThan(0);
    expect(env.KIMI_MODEL).toBe('k3');
  });

  it('falls back to default model when unset', () => {
    const env = validateAndLoadEnv();
    expect(env.KIMI_BASE_URL).toMatch(/^https:\/\//);
    expect(env.MISTRAL_BASE_URL).toMatch(/^https:\/\//);
  });
});

describe('isPlaceholder', () => {
  // Regression: local_dev_* values (the default values in the shipped
  // .env file) were NOT detected as placeholders, so a production
  // deploy with the dev .env would pass validation with publicly-known
  // passwords. See M34 — the placeholder detection list now covers
  // every dev/test prefix used in the .env template.
  it('detects local_dev_* passwords as placeholders', () => {
    expect(isPlaceholder('local_dev_pg_1a2b3c4d')).toBe(true);
    expect(isPlaceholder('local_dev_redis_5e6f7g8h')).toBe(true);
    expect(isPlaceholder('local_dev_api_secret_9a0b1c2d')).toBe(true);
    expect(isPlaceholder('local_dev_jwt_secret_7i8k0l')).toBe(true);
    expect(isPlaceholder('local_dev_admin_key_3e4f5g6h')).toBe(true);
    expect(isPlaceholder('local_dev_admin_pw_1m2n3o4p')).toBe(true);
  });

  it('detects dev_* prefixes as placeholders', () => {
    expect(isPlaceholder('dev_pg_password')).toBe(true);
    expect(isPlaceholder('dev_secret_key')).toBe(true);
    expect(isPlaceholder('DEV_PASSWORD')).toBe(true);
    expect(isPlaceholder('dev-secret')).toBe(true);
  });

  it('detects test_* underscore placeholders', () => {
    expect(isPlaceholder('test_password')).toBe(true);
    expect(isPlaceholder('test_secret_value')).toBe(true);
    expect(isPlaceholder('test_token_value')).toBe(true);
  });

  it('does NOT flag test-fixture literals as placeholders', () => {
    // These are real test values used by the test suite for JWT signing.
    // They start with `test-` but are real values, not placeholders.
    expect(isPlaceholder('test-secret-for-concurrency')).toBe(false);
    expect(isPlaceholder('test-api-secret-for-concurrency')).toBe(false);
    expect(isPlaceholder('test-jwt-secret-12345')).toBe(false);
  });

  it('detects common placeholder strings', () => {
    expect(isPlaceholder('changeme')).toBe(true);
    expect(isPlaceholder('CHANGEME')).toBe(true);
    expect(isPlaceholder('your-api-key')).toBe(true);
    expect(isPlaceholder('placeholder')).toBe(true);
    expect(isPlaceholder('fill_me_in')).toBe(true);
    expect(isPlaceholder('__SET_ME_TO_API_KEY__')).toBe(true);
    expect(isPlaceholder('replace_me')).toBe(true);
  });

  it('does NOT flag real-looking secrets as placeholders', () => {
    // Random 64-char hex (production-grade)
    expect(isPlaceholder('a'.repeat(64))).toBe(false);
    // Real API key shape from a provider
    expect(isPlaceholder('sk-proj-AbCdEf1234567890')).toBe(false);
    // OpenAI key with random suffix
    expect(isPlaceholder('sk-dtln8XIw0zcmwOBHR6n78h5lHG4mjNv5SS8AfNTfXIZRY0ww4iCk07mR7r1FuINa')).toBe(false);
    // bcrypt-shaped hash
    expect(isPlaceholder('$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy')).toBe(false);
  });

  it('does NOT flag empty or short strings as placeholders (those are caught by demand())', () => {
    expect(isPlaceholder('')).toBe(false);
    expect(isPlaceholder('a')).toBe(false);
    expect(isPlaceholder('ab')).toBe(false);
  });
});

describe('shouldBootstrapFirstUserAsAdmin', () => {
  // HIGH-6: regression tests for the first-user-becomes-admin security
  // gate. Default (no env set, open registration) MUST NOT elevate; the
  // env.test config defaults are intentionally not set for this flag.
  it('returns false in open registration mode without the explicit flag', () => {
    const priorDisable = process.env.DISABLE_REGISTRATION;
    const priorBootstrap = process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    delete process.env.DISABLE_REGISTRATION;
    delete process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    expect(shouldBootstrapFirstUserAsAdmin()).toBe(false);
    if (priorDisable !== undefined) process.env.DISABLE_REGISTRATION = priorDisable;
    if (priorBootstrap !== undefined) process.env.BOOTSTRAP_FIRST_USER_ADMIN = priorBootstrap;
  });

  it('returns true when BOOTSTRAP_FIRST_USER_ADMIN=true is set', () => {
    const priorDisable = process.env.DISABLE_REGISTRATION;
    const priorBootstrap = process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    delete process.env.DISABLE_REGISTRATION;
    process.env.BOOTSTRAP_FIRST_USER_ADMIN = 'true';
    expect(shouldBootstrapFirstUserAsAdmin()).toBe(true);
    delete process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    if (priorDisable !== undefined) process.env.DISABLE_REGISTRATION = priorDisable;
    if (priorBootstrap !== undefined) process.env.BOOTSTRAP_FIRST_USER_ADMIN = priorBootstrap;
  });

  it('returns true when registration is invite-only (DISABLE_REGISTRATION=true)', () => {
    // INVITE-coded registration implies operator intent — first authorised
    // user is implicitly trusted to become admin.
    const priorDisable = process.env.DISABLE_REGISTRATION;
    const priorBootstrap = process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    process.env.DISABLE_REGISTRATION = 'true';
    delete process.env.BOOTSTRAP_FIRST_USER_ADMIN;
    expect(shouldBootstrapFirstUserAsAdmin()).toBe(true);
    delete process.env.DISABLE_REGISTRATION;
    if (priorDisable !== undefined) process.env.DISABLE_REGISTRATION = priorDisable;
    if (priorBootstrap !== undefined) process.env.BOOTSTRAP_FIRST_USER_ADMIN = priorBootstrap;
  });
});

describe('H1 — production secret gates use normalized NODE_ENV', () => {
  // Regression: the strict secret gates previously compared the RAW
  // process.env.NODE_ENV against 'production'. With NODE_ENV unset (the
  // module's own default is 'production') or non-lowercase, every gate
  // silently failed open — random per-process secrets and passwordless Redis.
  async function loadFreshEnv() {
    vi.resetModules();
    return import('./env.js');
  }

  function setBaseEnv() {
    process.env.DATABASE_URL = 'postgresql://user:Str0ngPassw0rd@db:5432/app';
    process.env.REDIS_URL = 'redis://:Str0ngRedisPassw0rd@redis:6379';
    delete process.env.REDIS_PASSWORD;
    delete process.env.API_SECRET;
    delete process.env.ADMIN_API_KEY;
    delete process.env.JWT_SECRET;
  }

  function restoreEnv(saved: NodeJS.ProcessEnv) {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }

  it('throws when NODE_ENV is unset (defaults to production) and API_SECRET is missing', async () => {
    const saved = { ...process.env };
    try {
      setBaseEnv();
      delete process.env.NODE_ENV;
      const { validateAndLoadEnv } = await loadFreshEnv();
      expect(() => validateAndLoadEnv()).toThrowError(/API_SECRET is required in production/);
    } finally {
      restoreEnv(saved);
      vi.resetModules();
    }
  });

  it('throws when NODE_ENV is mixed-case Production and JWT_SECRET is missing', async () => {
    const saved = { ...process.env };
    try {
      setBaseEnv();
      process.env.API_SECRET = 'a'.repeat(64);
      process.env.ADMIN_API_KEY = 'b'.repeat(64);
      process.env.NODE_ENV = 'Production';
      const { validateAndLoadEnv } = await loadFreshEnv();
      expect(() => validateAndLoadEnv()).toThrowError(/JWT_SECRET is required in production/);
    } finally {
      restoreEnv(saved);
      vi.resetModules();
    }
  });

  it('still allows missing secrets when NODE_ENV=development', async () => {
    const saved = { ...process.env };
    try {
      setBaseEnv();
      process.env.NODE_ENV = 'development';
      const { validateAndLoadEnv } = await loadFreshEnv();
      const env = validateAndLoadEnv();
      expect(env.API_SECRET.length).toBeGreaterThan(0);
    } finally {
      restoreEnv(saved);
      vi.resetModules();
    }
  });
});
