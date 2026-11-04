import { test, expect } from '@playwright/test';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:34567';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

test.describe('SSE Connection', () => {
  let authToken: string;
  let xsrfToken: string;
  let jobId: string;

  /** Build CSRF headers using this describe's XSRF-TOKEN. */
  function csrfHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': xsrfToken,
      'Cookie': `XSRF-TOKEN=${xsrfToken}`,
    };
  }

  test.beforeAll(async ({ request }) => {
    const username = `e2e_api_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
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

  test('should connect to SSE endpoint and receive connected event', async ({ page, request }) => {
    const response = await request.post(`${API_BASE}/api/stories/generate`, {
      data: { genre: ['fantasy'], seed: `e2e-sse-${Date.now()}` },
      headers: {
        ...csrfHeaders(),
        Authorization: `Bearer ${authToken}`,
      },
    });
    expect(response.status(), 'generation request should be accepted').toBe(202);

    const data = await response.json() as { data?: { jobId?: string; sseUrl?: string; sseAuth?: { auth: string; t: number } } };
    expect(typeof data.data?.jobId, 'generation response should include a string jobId').toBe('string');
    expect(data.data?.jobId?.length, 'jobId should be non-empty').toBeGreaterThan(0);
    jobId = data.data!.jobId;

    // M52: assert an actual SSE frame arrives (the old test only proved
    // interception via page.route). Fetch the events endpoint directly with
    // the auth cookie and read the first `data:` line.
    const sseRes = await request.get(
      `${API_BASE}/api/stories/generate/${jobId}/events`,
      {
        headers: {
          Accept: 'text/event-stream',
          Cookie: `access_token=${authToken}`,
        },
        timeout: 10_000,
      }
    );
    expect(sseRes.status()).toBe(200);
    const body = await sseRes.text();
    expect(body).toContain('data:');
    expect(body).toMatch(/"type":"(connected|progress|complete|heartbeat)"/);
  });
});

test.describe('Story API Contract', () => {
  let authToken: string;
  let xsrfToken: string;

  function csrfHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': xsrfToken,
      'Cookie': `XSRF-TOKEN=${xsrfToken}`,
    };
  }

  /** Poll job status until completed. Returns storyId. */
  async function pollJobForStoryId(
    rq: import('@playwright/test').APIRequestContext,
    jobId: string,
    // M51: poll budget must fit inside the 2-minute test timeout — otherwise
    // Playwright's generic timeout error masks the descriptive poll error.
    timeoutMs = 110_000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statusRes = await rq.get(
        `${API_BASE}/api/stories/generate/${jobId}/status`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      if (statusRes.ok()) {
        const body = await statusRes.json() as {
          data?: { state: string; data?: { storyId?: string } };
        };
        if (body.data?.state === 'completed' && body.data?.data?.storyId) {
          return body.data.data.storyId;
        }
        if (body.data?.state === 'failed') {
          throw new Error(`Story generation job ${jobId} failed`);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for story generation job ${jobId}`);
  }

  test.beforeAll(async ({ request }) => {
    const username = `e2e_api_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
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

  test('POST /api/stories/generate should return jobId and requestId', async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/stories/generate`, {
      data: { genre: ['fantasy'], seed: `e2e-jobid-${Date.now()}` },
      headers: {
        ...csrfHeaders(),
        Authorization: `Bearer ${authToken}`,
      },
    });
    expect(response.status(), 'generation request should be accepted').toBe(202);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data).toHaveProperty('jobId');
    expect(data.data).toHaveProperty('requestId');
  });

  test('GET /api/stories should return paginated stories', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/stories`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status(), 'stories list should be reachable').toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data).toHaveProperty('stories');
    expect(Array.isArray(data.data.stories)).toBe(true);
  });

  test('story object should have correct structure', async ({ request }) => {
    test.setTimeout(120000);

    // Generate a story and poll job status for completion.
    const seed = `e2e-struct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const genRes = await request.post(`${API_BASE}/api/stories/generate`, {
      data: { genre: ['fantasy'], seed },
      headers: { ...csrfHeaders(), Authorization: `Bearer ${authToken}` },
    });
    expect(genRes.status(), 'generation request should be accepted').toBe(202);

    const genData = await genRes.json() as { data?: { jobId?: string } };
    const jobId = genData.data?.jobId;
    expect(typeof jobId, 'generation response should include a string jobId').toBe('string');
    expect(jobId?.length, 'jobId should be non-empty').toBeGreaterThan(0);

    // Wait for the worker to complete the job (poll status endpoint).
    const storyId = await pollJobForStoryId(request, jobId!);

    // Fetch the story detail from the DB-backed API.
    const storyRes = await request.get(`${API_BASE}/api/stories/${storyId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(storyRes.status(), 'story detail should be reachable after generation').toBe(200);

    const storyBody = await storyRes.json() as { data: Record<string, unknown> };
    const story = storyBody.data;
    expect(story).toHaveProperty('id');
    expect(story).toHaveProperty('title');
    expect(story).toHaveProperty('genre');
    expect(story).toHaveProperty('status');
    expect(story).toHaveProperty('episodes');
    expect(story).toHaveProperty('characters');
  });
});

test.describe('Health Check', () => {
  test('should have health endpoint', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/health`);
    expect(response.status(), 'health endpoint should return 200').toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
