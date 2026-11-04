import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function mockJson(body: unknown, init?: ResponseInit) {
  return {
    status: init?.status || 200,
    statusText: init?.statusText || 'OK',
    body: JSON.stringify(body),
    headers: new Headers(init?.headers),
  };
}

vi.mock('next/server', () => {
  const MockNextRequest = class {
    readonly nextUrl: URL;
    readonly headers: Headers;
    readonly method: string;
    readonly body: ReadableStream<Uint8Array> | null;

    constructor(init: { url: string; method?: string; headers?: Record<string, string>; body?: string }) {
      this.nextUrl = new URL(init.url);
      this.method = init.method || 'GET';
      this.headers = new Headers(init.headers || {});
      if (init.body) {
        const encoder = new TextEncoder();
        this.body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(init.body!));
            controller.close();
          },
        });
      } else {
        this.body = null;
      }
    }

    async json() {
      if (!this.body) throw new Error('No body');
      const reader = this.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    }

    async text() {
      if (!this.body) return '';
      const reader = this.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    }
  };

  const MockNextResponse = class {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    readonly body: unknown;

    constructor(body: unknown, init?: ResponseInit) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.statusText = init?.statusText || 'OK';
      this.headers = new Headers(init?.headers);
    }
  };
  (MockNextResponse as any).json = mockJson;

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

let MockNextRequestClass: any;
let MockNextResponseClass: any;
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Re-import after mocks are set up
const { NextRequest: NextRequestMock, NextResponse: NextResponseMock } = await import('next/server');
MockNextRequestClass = NextRequestMock;
MockNextResponseClass = NextResponseMock;
(globalThis as any).NextRequest = MockNextRequestClass;
(globalThis as any).NextResponse = MockNextResponseClass;
const { GET, POST, DELETE, PUT: __PUT, PATCH: __PATCH } = await import('./route');

function toStream(data: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

function makeRequest(path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) {
  const url = `http://localhost:3000${path}`;
  return new (globalThis as any).NextRequest({
    url,
    method: options?.method || 'GET',
    headers: options?.headers || {},
    body: options?.body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.API_BASE_URL = 'http://backend:34567';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BFF Proxy', () => {
  it('forwards GET requests to the backend', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({ data: 'test' })),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories');
    await GET(req);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [callUrl] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(callUrl).toBe('http://backend:34567/api/stories');
  });

  it('forwards POST with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      statusText: 'Created',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({ id: 'new-story' })),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    await POST(req);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(callUrl).toBe('http://backend:34567/api/stories');
    expect(callInit.method).toBe('POST');
    expect((callInit.headers as Headers).get('content-type')).toBe('application/json');
  });

  it('sanitizes forwarded headers — does NOT forward x-forwarded-for from client', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({})),
      getSetCookie: () => [],
    });

    const validBearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.a';
    const req = makeRequest('/api/stories', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'http',
        'cookie': 'session=abc',
        'authorization': validBearer,
      },
    });
    await GET(req);

    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const callHeaders = callInit.headers as Headers;
    // BFF sets its own trusted X-Forwarded-* headers rather than forwarding
    // attacker-controlled client values. When req.ip is unavailable in the
    // test environment, the BFF reports 'unknown' instead of trusting the
    // client-supplied X-Forwarded-For chain.
    expect(callHeaders.get('x-forwarded-for')).toBe('unknown');
    // BFF sets its own trusted x-forwarded-proto from the request URL
    expect(callHeaders.get('x-forwarded-proto')).toBe('http');
    // Allowed headers should be forwarded
    expect(callHeaders.get('cookie')).toBe('session=abc');
    // Valid Bearer JWT shape is forwarded
    expect(callHeaders.get('authorization')).toBe(validBearer);
  });

  it('does NOT forward malformed authorization headers', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({})),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories', {
      headers: {
        'authorization': 'Basic dXNlcjpwYXNz',
      },
    });
    await GET(req);

    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const callHeaders = callInit.headers as Headers;
    expect(callHeaders.get('authorization')).toBeNull();
  });

  it('returns 404 for disallowed BFF paths', async () => {
    const req = makeRequest('/api/docs');
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe('Not allowed');
  });

  it('returns 404 for disallowed BFF methods', async () => {
    const req = makeRequest('/api/health', { method: 'DELETE' });
    const res = await DELETE(req);
    expect(res.status).toBe(404);
  });

  it('uses server protocol for x-forwarded-proto instead of trusting client header', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({})),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories', {
      headers: {
        'x-forwarded-proto': 'https',
        'cookie': 'session=abc',
      },
    });
    await GET(req);

    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const callHeaders = callInit.headers as Headers;
    // CRIT-8: BFF now uses its own protocol, not the client-supplied header.
    // This prevents a client from spoofing the protocol to bypass HTTPS checks.
    expect(callHeaders.get('x-forwarded-proto')).not.toBe('https');
  });

  it('returns 504 on proxy timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const req = makeRequest('/api/stories');
    const res = await GET(req);

    expect(res.status).toBe(504);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe('Proxy request timed out');
  });

  it('returns 502 when backend is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const req = makeRequest('/api/stories');
    const res = await GET(req);

    expect(res.status).toBe(502);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe('Backend service unreachable');
  });

  it('forwards Set-Cookie headers correctly', async () => {
    const responseHeaders = new Headers({ 'content-type': 'application/json' });
    responseHeaders.append('set-cookie', 'session=abc; Path=/');
    responseHeaders.append('set-cookie', 'csrf=xyz; Path=/');

    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: responseHeaders,
      body: toStream(JSON.stringify({ ok: true })),
      getSetCookie: () => ['session=abc; Path=/', 'csrf=xyz; Path=/'],
    });

    const req = makeRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test', password: 'test' }),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);

    // M48: assert the actual Set-Cookie forwarding — the route deletes and
    // re-appends each backend Set-Cookie. A regression collapsing them into
    // one header must fail here.
    expect(res.status).toBe(200);
    const setCookies: string[] = [];
    for (const [k, v] of res.headers.entries()) {
      if (k === 'set-cookie') setCookies.push(v);
    }
    const joined = setCookies.join(', ');
    expect(joined).toContain('session=abc');
    expect(joined).toContain('csrf=xyz');
  });

  it('handles SSE streams', async () => {
    const sseData = 'event: progress\ndata: {"stage": "blueprint"}\n\n';
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      }),
      body: toStream(sseData),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories/generate/abc/events', {
      headers: { accept: 'text/event-stream' },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('forwards DELETE requests', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({ deleted: true })),
      getSetCookie: () => [],
    });

    const req = makeRequest('/api/stories/abc', { method: 'DELETE' });
    await DELETE(req);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(callInit.method).toBe('DELETE');
  });

  // ─── M3: BFF proxy defect fixes + previously untested branches ───────────────
  function ok200() {
    return {
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: toStream(JSON.stringify({ ok: true })),
      getSetCookie: () => [],
    };
  }

  it('M3: forwards a bodyless JSON POST without a 400', async () => {
    mockFetch.mockResolvedValueOnce(ok200());
    // apiFetch always sends Content-Type: application/json even with no body
    // (e.g. POST /api/auth/refresh). Previously req.json() threw → 400.
    const req = makeRequest('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('M3: returns 400 for a malformed JSON body', async () => {
    const req = makeRequest('/api/stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe('Invalid JSON body');
  });

  it('M3: allows /api/admin/* through the BFF', async () => {
    mockFetch.mockResolvedValueOnce(ok200());
    const req = makeRequest('/api/admin/queue');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const [callUrl] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(callUrl).toBe('http://backend:34567/api/admin/queue');
  });

  it('M3: uses X-Real-IP for the forwarded client IP when present', async () => {
    mockFetch.mockResolvedValueOnce(ok200());
    const req = makeRequest('/api/stories', {
      headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' },
    });
    await GET(req);
    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect((callInit.headers as Headers).get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('M3: returns 503 (not 500) when API_BASE_URL is not configured', async () => {
    delete process.env.API_BASE_URL;
    const req = makeRequest('/api/stories');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = JSON.parse(String(res.body));
    expect(body.error).toBe('Proxy not configured');
  });

  it('M3: forwards PUT and PATCH requests', async () => {
    for (const [method, handler] of [['PUT', __PUT], ['PATCH', __PATCH]] as const) {
      mockFetch.mockResolvedValueOnce(ok200());
      const req = makeRequest('/api/stories/abc', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      });
      await handler(req as unknown as Parameters<typeof handler>[0]);
      const last = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]! as [string, RequestInit];
      expect(last[1].method).toBe(method);
    }
  });

  it('M3: forwards the query string to the backend', async () => {
    mockFetch.mockResolvedValueOnce(ok200());
    const req = makeRequest('/api/stories?limit=5&cursor=abc');
    await GET(req);
    const [callUrl] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(callUrl).toBe('http://backend:34567/api/stories?limit=5&cursor=abc');
  });

  it('M3: forwards the client x-request-id to the backend', async () => {
    mockFetch.mockResolvedValueOnce(ok200());
    const req = makeRequest('/api/stories', { headers: { 'x-request-id': 'req-123' } });
    await GET(req);
    const [, callInit] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect((callInit.headers as Headers).get('x-request-id')).toBe('req-123');
  });

  it('M3: returns 502 when the SSE backend response has no body', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: null,
      getSetCookie: () => [],
    });
    const req = makeRequest('/api/stories/generate/abc/events', {
      headers: { accept: 'text/event-stream' },
    });
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it('M3: honors PROXY_TIMEOUT_MS for the proxy fetch timeout', async () => {
    process.env.PROXY_TIMEOUT_MS = '30';
    try {
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        })
      );
      const req = makeRequest('/api/stories');
      const res = await GET(req);
      expect(res.status).toBe(504);
    } finally {
      delete process.env.PROXY_TIMEOUT_MS;
    }
  });
});
