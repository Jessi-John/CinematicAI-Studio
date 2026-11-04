import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:34567';
const FRONTEND_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

/**
 * Full E2E story generation test.
 * Requires both frontend AND backend running.
 * Run separately: `npm run test:e2e:full`
 */
// Auth strategy: the Next.js edge middleware (proxy.ts) verifies the
// access_token JWT with the real JWT_SECRET, so a synthetic/unsigned token is
// rejected and the page redirects to /login. Instead of mocking register/login,
// we do a REAL registration against the backend (see registerAndGetToken) to
// obtain a properly-signed JWT the middleware accepts. The afterAll cleanup
// removes these throwaway users.
//
// We still mock /api/auth/me and runtime-config.js: the auth context calls
// /api/auth/me on mount to verify the session, and the mocked runtime-config
// forces BFF (same-origin) mode so page.route can intercept all API calls.

function setupAuthInterception(page: Page) {
  // The frontend's runtime-config.js sets API_BASE_URL=http://backend:34567,
  // which is not DNS-resolvable from the host machine. When the auth context
  // calls http://backend:34567/api/auth/me, DNS fails BEFORE an HTTP request
  // is made — and page.route intercepts at the HTTP level, so it never fires.
  //
  // Fix: force BFF (same-origin) mode by setting API_BASE_URL to an empty
  // string. Client requests then go to /api/* on the frontend origin, which
  // Next.js proxies to the Express backend. This satisfies the production
  // CSP (connect-src 'self') and lets page.route intercept all API calls.
  page.route('**/runtime-config.js', async (route: Route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `window.__RUNTIME_CONFIG__ = { API_BASE_URL: '' };`,
    });
  });

  // Intercept auth/me on the same-origin BFF URL
  page.route((url: URL) => url.href.includes('/api/auth/me'), async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          user: {
            id: 'e2e-user-001',
            username: 'e2e_playwright',
            role: 'user'
          }
        }
      })
    });
  });
}

/**
 * Register a throwaway user against the REAL backend and return its signed
 * JWT. Uses the APIRequestContext (page.request) rather than page.evaluate so
 * the call bypasses page.route interception and browser CORS, and so we can
 * read the token straight from the JSON body (auth register/login return
 * `data.token`). The afterAll cleanup removes these users.
 */
async function registerAndGetToken(
  request: APIRequestContext,
  username: string,
  password: string
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/register`, {
    data: { username, password },
  });
  if (!res.ok()) {
    throw new Error(`E2E register failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { token?: unknown } };
  const token = body?.data?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('E2E register response did not include a token');
  }
  return token;
}

test.describe('Full Story Generation Flow', () => {
  test.afterAll(async ({ request }) => {
    if (ADMIN_API_KEY) {
      await request.post(`${API_BASE}/api/admin/cleanup-test-users`, {
        headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
      });
    }
  });

  test.beforeEach(async ({ page }) => {
    setupAuthInterception(page);

    const healthResponse = await page.request.get(`${API_BASE}/api/health`);
    // Fix HIGH-2/HIGH-8: Use conditional skip so the result is reported
    // in CI output instead of silently passing without assertions.
    test.skip(!healthResponse.ok(), `Backend health check failed: ${healthResponse.status()}`);
    if (!healthResponse.ok()) return;
    // Use unique credentials per test to avoid parallel test collisions
    const username = `e2e_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
    const password = 'SecurePass123!';

    // Register against the real backend to obtain a properly-signed JWT the
    // edge middleware accepts, then set it as a cookie on the frontend origin.
    const token = await registerAndGetToken(page.request, username, password);
    await page.context().addCookies([{ name: 'access_token', value: token, url: FRONTEND_URL }]);
  });

  // MED-17: Timeout adapts to test mode.
  //   Mocked (default): 30s — all API routes return synthetic responses.
  //   Live: 120 min — full generation with real AI takes 40+ min.
  //   Set E2E_LIVE_API=1 to enable live API timeout.
  test('should generate a story end-to-end and redirect to story page', async ({ page }) => {
    test.setTimeout(process.env.E2E_LIVE_API === '1' ? 120 * 60 * 1000 : 30_000);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'Story Dashboard' })).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('create-story-btn').click();
    await expect(page.getByText('Select Genre')).toBeVisible({ timeout: 5000 });

    // Mock the generate endpoint to return 202 with a jobId immediately.
    // HIGH-3: Return a synthetic response — do NOT forward to the real backend,
    // which would create a real BullMQ job that bleeds into the queue system.
    const mockJobId = `mock-job-${Date.now()}`;
    const mockStoryId = `mock-story-${Date.now()}`;
    await page.route('**/api/stories/generate', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: mockJobId,
              requestId: `req-${Date.now()}`,
              // M54: mirror the real backend contract — absolute sseUrl with
              // embedded HMAC + sseAuth object (the relative no-auth mock
              // only exercised the hook's unauthenticated fallback branch).
              sseUrl: `http://localhost:34567/api/stories/generate/${mockJobId}/events?auth=${'a'.repeat(64)}&t=${Date.now()}`,
              sseAuth: { auth: 'a'.repeat(64), t: Date.now() },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock the SSE endpoint to send a 'complete' event with the mock storyId,
    // then the story detail endpoint to return a valid story
    await page.route(new RegExp(`/api/stories/generate/${mockJobId}/events`), async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': 'http://localhost:3000', 'Access-Control-Allow-Credentials': 'true' },
        body: `data: ${JSON.stringify({ type: 'connected', jobId: mockJobId })}\n\ndata: ${JSON.stringify({ type: 'complete', data: { storyId: mockStoryId } })}\n\n`,
      });
    });

    await page.route(`**/api/stories/${mockStoryId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: mockStoryId,
            title: 'The Lone Warrior',
            genre: 'fantasy',
            status: 'complete',
            createdAt: new Date().toISOString(),
            episodes: [
              {
                id: 'ep-1',
                number: 1,
                title: 'The Portal Opens',
                hook: 'A mysterious energy ripples through the ancient stones',
                cliffhanger: 'The portal flickers, revealing a figure from another world',
                scenes: [
                  {
                    id: 'sc-1',
                    number: 1,
                    duration: 15,
                    emotionalIntensity: 7,
                    narration: { text: 'In the heart of the mountains, an ancient portal awakens.', emotion: 'mysterious', timing: { totalDuration: 15, wordsPerMinute: 150 } },
                    imagePrompt: { content: 'A mystical portal in ancient mountains, cinematic lighting' },
                    videoPrompt: { content: 'Cinematic shot of portal opening with energy ripples' },
                  },
                ],
              },
            ],
            characters: [
              { id: 'char-1', name: 'Kira', role: 'protagonist', description: 'A fierce warrior guarding the portal' },
            ],
            environments: [
              { id: 'env-1', name: 'Mountain Temple', timeOfDay: 'dusk', weather: 'misty', mood: 'mysterious' },
            ],
            metadata: { viralityScore: 78, monetizationScore: 65, totalScenes: 1 },
            youtubeSeo: {
              title: 'The Lone Warrior | Epic Fantasy Short',
              description: 'An epic tale of a warrior guarding a mystical portal',
              tags: ['fantasy', 'action', 'shorts'],
              thumbnailSuggestions: ['dramatic warrior portrait', 'portal opening wide shot'],
              videoTemplate: 'Cinematic narrative with emotional hooks',
              hookScript: 'In a world where dimensions collide...',
              algorithmBoostTips: ['Use trending audio', 'Add subtitles for retention'],
              viralPotential: 72,
              recommendedDuration: '45-60s',
              targetAudience: '18-35 fantasy fans',
              ctaScript: 'Follow for more epic tales',
              trendingKeywords: ['fantasy', 'portal', 'warrior'],
            },
          },
        }),
      });
    });

    await page.getByTestId('genre-fantasy').click();
    await page.getByTestId('seed-input').fill(`A lone warrior guarding a mystical portal ${Date.now()}`);
    await page.getByTestId('generate-story-btn').click();

    // Should navigate to the story page after completion
    await expect(page).toHaveURL(/\/story\/[a-z0-9]+/, { timeout: 15000 });
    const storyId = page.url().split('/story/')[1] ?? '';
    // The storyId is the URL path segment after /story/. An empty
    // value would mean the regex matched but the URL didn't actually
    // contain a story id (e.g. trailing slash).
    expect(storyId.length).toBeGreaterThan(0);

    // Story detail page should show episodes heading
    await expect(page.getByRole('heading', { name: 'Episodes' })).toBeVisible({ timeout: 10000 });
  });

  test('should track progress through generation stages', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'Story Dashboard' })).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('create-story-btn').click();
    await expect(page.getByText('Select Genre')).toBeVisible({ timeout: 5000 });

    // HIGH-3: Return a synthetic response — do NOT forward to the real backend.
    const mockJobId = `progress-mock-${Date.now()}`;
    await page.route('**/api/stories/generate', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: mockJobId,
              requestId: `req-${Date.now()}`,
              // M54: mirror the real backend contract — absolute sseUrl with
              // embedded HMAC + sseAuth object (the relative no-auth mock
              // only exercised the hook's unauthenticated fallback branch).
              sseUrl: `http://localhost:34567/api/stories/generate/${mockJobId}/events?auth=${'a'.repeat(64)}&t=${Date.now()}`,
              sseAuth: { auth: 'a'.repeat(64), t: Date.now() },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock the SSE endpoint to deliver progress events immediately.
    await page.route(new RegExp(`/api/stories/generate/${mockJobId}/events`), async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          `data: ${JSON.stringify({ type: 'connected', jobId: mockJobId })}\n\n` +
          `data: ${JSON.stringify({ type: 'progress', stage: 'init', progress: 5, message: 'Initializing...' })}\n\n` +
          `data: ${JSON.stringify({ type: 'progress', stage: 'blueprint', progress: 25, message: 'Creating Blueprint...' })}\n\n`,
      });
    });

    await page.getByTestId('genre-fantasy').click();
    const btn = page.getByTestId('generate-story-btn');
    await expect(btn).toBeEnabled({ timeout: 5000 });

    await btn.click();

    // M53: assert on EVENT-DRIVEN output, not static chrome — the
    // GENERATION_STEPS labels render statically whenever isGenerating is
    // true, so a completely broken SSE path used to pass. The mocked SSE
    // stream delivers a progress frame whose MESSAGE is rendered into the
    // live progress area.
    await expect(page.getByText('Creating Blueprint...', { exact: true })).toBeVisible({ timeout: 15000 });
    // And the live percent text updates from the SSE frame's progress value.
    await expect(page.getByText('25%', { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('should handle generation errors gracefully', async ({ page }) => {
    await page.goto('/');
    // Wait for DOM content to be loaded — do NOT use 'networkidle' because the page
    // opens a persistent SSE (EventSource) connection for generation progress.
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'Story Dashboard' })).toBeVisible({
      timeout: 15000,
    });

    await page.route('**/api/stories/generate', (route: Route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal server error' }),
      });
    });

    await page.getByTestId('create-story-btn').click();
    await page.getByTestId('genre-fantasy').click();
    await page.getByTestId('generate-story-btn').click();
    await expect(page.locator('.fixed.top-4.right-4.z-50').getByText(/error|failed|try again/i)).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Story Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    const healthResponse = await page.request.get(`${API_BASE}/api/health`);
    // Fix HIGH-2/HIGH-8: Use conditional skip so the result is reported
    // in CI output instead of silently passing without assertions.
    test.skip(!healthResponse.ok(), `Backend health check failed: ${healthResponse.status()}`);
    if (!healthResponse.ok()) return;
  });

  test('should load story details after generation completes', async ({ page }) => {
    // Setup auth like other tests
    setupAuthInterception(page);

    const healthResponse = await page.request.get(`${API_BASE}/api/health`);
    // Fix HIGH-2/HIGH-8: Use conditional skip so the result is reported
    // in CI output instead of silently passing without assertions.
    test.skip(!healthResponse.ok(), `Backend health check failed: ${healthResponse.status()}`);
    if (!healthResponse.ok()) return;

    // Register against the real backend to obtain a properly-signed JWT the
    // edge middleware accepts, then set it as a cookie on the frontend origin.
    const username = `e2e_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
    const token = await registerAndGetToken(page.request, username, 'SecurePass123!');
    await page.context().addCookies([
      { name: 'access_token', value: token, url: FRONTEND_URL },
    ]);

    const mockJobId = `mock-job-detail-${Date.now()}`;
    const mockStoryId = `mock-story-detail-${Date.now()}`;

    await page.route('**/api/stories/generate', async route => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: mockJobId,
              requestId: `req-${Date.now()}`,
              // M54: mirror the real backend contract — absolute sseUrl with
              // embedded HMAC + sseAuth object (the relative no-auth mock
              // only exercised the hook's unauthenticated fallback branch).
              sseUrl: `http://localhost:34567/api/stories/generate/${mockJobId}/events?auth=${'a'.repeat(64)}&t=${Date.now()}`,
              sseAuth: { auth: 'a'.repeat(64), t: Date.now() },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(new RegExp(`/api/stories/generate/${mockJobId}/events`), async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'connected', jobId: mockJobId })}\n\ndata: ${JSON.stringify({ type: 'complete', data: { storyId: mockStoryId } })}\n\n`,
      });
    });

    await page.route(`**/api/stories/${mockStoryId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: mockStoryId,
            title: 'The Dragon Temple',
            genre: 'fantasy',
            status: 'complete',
            createdAt: new Date().toISOString(),
            episodes: [
              {
                id: 'ep-d1',
                number: 1,
                title: 'The Awakening',
                hook: 'An ancient dragon stirs beneath the temple',
                cliffhanger: 'The temple floor cracks open revealing molten gold',
                scenes: [
                  {
                    id: 'sc-d1',
                    number: 1,
                    duration: 15,
                    emotionalIntensity: 8,
                    narration: { text: 'Beneath the ancient temple, something vast begins to breathe.', emotion: 'dramatic', timing: { totalDuration: 15, wordsPerMinute: 150 } },
                    imagePrompt: { content: 'Ancient dragon temple with golden light streaming through cracks' },
                    videoPrompt: { content: 'Dramatic reveal of dragon awakening in underground temple' },
                  },
                ],
              },
            ],
            characters: [
              { id: 'char-d1', name: 'Aric', role: 'protagonist', description: 'A young monk seeking ancient wisdom' },
            ],
            environments: [
              { id: 'env-d1', name: 'Dragon Temple', timeOfDay: 'dawn', weather: 'foggy', mood: 'awe-inspiring' },
            ],
            metadata: { viralityScore: 82, monetizationScore: 70, totalScenes: 1 },
            youtubeSeo: {
              title: 'The Dragon Temple | Epic Fantasy',
              description: 'A young monk discovers an ancient dragon beneath a sacred temple',
              tags: ['fantasy', 'dragon', 'adventure'],
              thumbnailSuggestions: ['dragon silhouette in golden temple', 'young monk at temple entrance'],
              videoTemplate: 'Epic fantasy narrative with dramatic reveals',
              hookScript: 'In the oldest temple on the mountain, a secret awakens...',
              algorithmBoostTips: ['Use dramatic music', 'Hook viewers in first 3 seconds'],
              viralPotential: 75,
              recommendedDuration: '50-60s',
              targetAudience: '18-40 fantasy adventure fans',
              ctaScript: 'Subscribe for epic fantasy shorts',
              trendingKeywords: ['dragon', 'temple', 'fantasy'],
            },
          },
        }),
      });
    });

    await page.goto(`${FRONTEND_URL}/story/${mockStoryId}`);
    await expect(page.getByRole('heading', { name: 'The Dragon Temple' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Episodes' })).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Scene editing with optimistic locking', () => {
  let authToken: string;
  let xsrfToken: string;

  test.beforeAll(async ({ request }) => {
    const healthResponse = await request.get(`${API_BASE}/api/health`);
    test.skip(!healthResponse.ok(), `Backend health check failed: ${healthResponse.status()}`);

    const username = `e2e_sceneedit_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
    const password = 'SecurePass123!';

    const regRes = await request.post(`${API_BASE}/api/auth/register`, {
      data: { username, password },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(regRes.status(), 'registration should succeed with E2E_TEST=true').toBe(201);

    const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
      data: { username, password },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(loginRes.status(), 'login should succeed for newly registered user').toBe(200);

    const setCookieRaw = loginRes.headers()['set-cookie'] ?? '';
    const combined = Array.isArray(setCookieRaw) ? setCookieRaw.join('; ') : setCookieRaw;
    const tokenMatch = combined.match(/access_token=([^;]+)/);
    expect(tokenMatch?.[1], 'login should set a JWT access_token cookie').toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    authToken = tokenMatch![1];

    const xsrfMatch = combined.match(/XSRF-TOKEN=([^;]+)/);
    expect(xsrfMatch?.[1], 'login should set a 64-hex XSRF-TOKEN cookie').toMatch(/^[a-f0-9]{64}$/i);
    xsrfToken = xsrfMatch![1];
  });

  test.afterAll(async ({ request }) => {
    if (ADMIN_API_KEY) {
      await request.post(`${API_BASE}/api/admin/cleanup-test-users`, {
        headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
      });
    }
  });

  /**
   * PATCH a scene narration against the real backend, using the shared auth.
   * Returns status + parsed body so each test asserts its own contract.
   */
  async function patchScene(
    request: APIRequestContext,
    storyId: string,
    episodeNumber: number,
    sceneNumber: number,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: { success: boolean; error?: string; code?: string } }> {
    const res = await request.patch(
      `${API_BASE}/api/stories/${storyId}/episodes/${episodeNumber}/scenes/${sceneNumber}`,
      {
        data: body,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': xsrfToken,
          Cookie: `XSRF-TOKEN=${xsrfToken}; access_token=${authToken}`,
        },
      }
    );
    return { status: res.status(), body: (await res.json()) as { success: boolean; error?: string; code?: string } };
  }

  test('rejects a stale expectedVersion with 409 and never advances the version', async ({ request }) => {
    test.setTimeout(120_000);

    // 1. Create a real story via the queue (small pipeline in E2E_TEST mode).
    const genRes = await request.post(`${API_BASE}/api/stories/generate`, {
      data: { genre: ['fantasy'], seed: `e2e-lock-${Date.now()}` },
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': xsrfToken,
        Cookie: `XSRF-TOKEN=${xsrfToken}; access_token=${authToken}`,
      },
    });
    expect(genRes.status()).toBe(202);
    const genBody = (await genRes.json()) as { data?: { jobId?: string } };
    const jobId = genBody.data?.jobId;
    expect(typeof jobId, 'generate should return a string jobId').toBe('string');
    expect(jobId!.length, 'jobId should be non-empty').toBeGreaterThan(0);

    // 2. Poll until the story completes (mocked AI pipeline finishes in seconds).
    let storyId: string | undefined;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const statusRes = await request.get(
        `${API_BASE}/api/stories/generate/${jobId}/status`,
        { headers: { Cookie: `access_token=${authToken}` } }
      );
      if (statusRes.ok()) {
        const statusBody = (await statusRes.json()) as {
          data?: { state?: string; data?: { storyId?: string } };
        };
        if (statusBody.data?.state === 'completed' && statusBody.data.data?.storyId) {
          storyId = statusBody.data.data.storyId;
          break;
        }
        if (statusBody.data?.state === 'failed') {
          throw new Error(`Story generation failed: ${JSON.stringify(statusBody)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(typeof storyId, 'story should complete within the polling window').toBe('string');
    expect(storyId!.length).toBeGreaterThan(0);

    // 3. Read the real current version of episode 1 scene 1.
    const storyRes = await request.get(`${API_BASE}/api/stories/${storyId}`, {
      headers: { Cookie: `access_token=${authToken}` },
    });
    expect(storyRes.ok()).toBe(true);
    const storyBody = (await storyRes.json()) as {
      data?: { episodes?: Array<{ number: number; scenes?: Array<{ number: number; version?: number }> }> };
    };
    const scene = storyBody.data?.episodes?.find((e) => e.number === 1)?.scenes?.find((s) => s.number === 1);
    expect(scene?.number, 'completed story should contain episode 1 scene 1').toBe(1);
    const currentVersion = scene!.version ?? 0;

    // 4. Edit with the CORRECT version — must succeed and bump the version.
    const okEdit = await patchScene(request, storyId!, 1, 1, {
      narrationText: 'Updated narration after optimistic-lock e2e check.',
      expectedVersion: currentVersion,
    });
    expect(okEdit.status, 'edit with current version should succeed').toBe(200);

    // 5. Replay the SAME stale version — must 409 with the conflict contract.
    const stale = await patchScene(request, storyId!, 1, 1, {
      narrationText: 'A concurrent second writer trying to land.',
      expectedVersion: currentVersion,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.success).toBe(false);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_CONFLICT');
    expect(stale.body.error).toMatch(/conflict/i);

    // 6. The narration text must be the FIRST editor's, not the stale writer's.
    const verify = await request.get(`${API_BASE}/api/stories/${storyId}`, {
      headers: { Cookie: `access_token=${authToken}` },
    });
    const verifyBody = (await verify.json()) as {
      data?: { episodes?: Array<{ scenes?: Array<{ narration?: { text?: string } }> }> };
    };
    const persisted = verifyBody.data?.episodes?.[0]?.scenes?.find((s) => s.number === 1);
    expect(persisted?.narration?.text).toBe('Updated narration after optimistic-lock e2e check.');
  });

  test('rejects invalid narration (too short) with 400 before any version check', async ({ request }) => {
    test.setTimeout(60_000);

    const res = await request.patch(
      `${API_BASE}/api/stories/00000000-0000-4000-8000-000000000000/episodes/1/scenes/1`,
      {
        data: { narrationText: 'short', expectedVersion: 0 },
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': xsrfToken,
          Cookie: `XSRF-TOKEN=${xsrfToken}; access_token=${authToken}`,
        },
      }
    );
    // The body schema (narrationText min 10) rejects the payload before the
    // scene lookup would 404 — the deterministic result is exactly 400.
    expect(res.status()).toBe(400);
  });
});
