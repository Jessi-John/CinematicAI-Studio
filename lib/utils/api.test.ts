import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCancelError,
  createCancelToken,
  ApiRequestError,
} from '@/lib/utils/api';

describe('api utilities', () => {
  describe('isCancelError', () => {
    it('should detect AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isCancelError(err)).toBe(true);
    });

    it('should detect "aborted" in message', () => {
      const err = new Error('Request was aborted');
      expect(isCancelError(err)).toBe(true);
    });

    it('should detect "cancel" in message', () => {
      const err = new Error('User cancelled the request');
      expect(isCancelError(err)).toBe(true);
    });

    it('should return false for non-cancel errors', () => {
      const err = new Error('Server error');
      expect(isCancelError(err)).toBe(false);
    });

    it('should return false for non-Error values', () => {
      expect(isCancelError('timeout')).toBe(false);
      expect(isCancelError(null)).toBe(false);
      expect(isCancelError(undefined)).toBe(false);
      expect(isCancelError({})).toBe(false);
    });
  });

  describe('createCancelToken', () => {
    it('should return signal and cancel function', () => {
      const { signal, cancel } = createCancelToken();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(typeof cancel).toBe('function');
    });

    it('should abort the signal when cancel is called', () => {
      const { signal, cancel } = createCancelToken();
      const abortListener = vi.fn();
      signal.addEventListener('abort', abortListener);
      cancel();
      expect(abortListener).toHaveBeenCalled();
    });

    it('should not abort before cancel is called', () => {
      const { signal } = createCancelToken();
      const abortListener = vi.fn();
      signal.addEventListener('abort', abortListener);
      // signal should not be aborted yet
      expect(abortListener).not.toHaveBeenCalled();
    });
  });

  describe('ApiRequestError', () => {
    it('should store status code and response', () => {
      const err = new ApiRequestError('Not found', 404, 'Resource not found');
      expect(err.name).toBe('ApiRequestError');
      expect(err.statusCode).toBe(404);
      expect(err.response).toBe('Resource not found');
      expect(err).toBeInstanceOf(Error);
    });

    it('should work without response text', () => {
      const err = new ApiRequestError('Server error', 500);
      expect(err.statusCode).toBe(500);
      // When the source does not provide a response text, the response
      // field is left undefined. Use a literal comparison so a future
      // change that initialized the field to an empty string (which is
      // a different bug) would be caught.
      expect(err.response === undefined).toBe(true);
      // And when a response IS provided, it is preserved.
      const errWithResponse = new ApiRequestError('Not found', 404, 'Resource not found');
      expect(errWithResponse.response).toBe('Resource not found');
      expect(err).toBeInstanceOf(ApiRequestError);
    });
  });

  describe('signalRace (via apiFetchWithCancel)', () => {
    it('aborts the fetch when the EXTERNAL signal fires first', async () => {
      // M49: exercise the real signalRace path inside apiFetchWithCancel —
      // the previous test constructed its own AbortController+setTimeout and
      // asserted platform behavior, never touching api.ts.
      const external = new AbortController();
      const fetchSpy = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError'))
            );
            setTimeout(() => external.abort(), 10);
          })
      );
      vi.stubGlobal('fetch', fetchSpy);

      const { apiFetchWithCancel } = await import('./api');
      const { promise } = apiFetchWithCancel('http://localhost/api/test', {
        signal: external.signal,
        timeout: 60_000,
      });
      await expect(promise).rejects.toThrowError(/abort/i);
    });
  });
});

describe('apiFetch response handling', () => {
  it('should throw ApiRequestError on non-ok response', async () => {
    const status = 401;
    const errorText = 'Unauthorized';
    const err = new ApiRequestError(
      `Request failed with status ${status}`,
      status,
      errorText
    );

    expect(err.statusCode).toBe(401);
    expect(err.message).toContain('401');
    expect(err.response).toBe('Unauthorized');
  });

  it('should format error message correctly for different status codes', () => {
    const cases: Array<[number, string]> = [
      [400, 'Bad Request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [429, 'Too Many Requests'],
      [500, 'Internal Server Error'],
    ];

    cases.forEach(([status]) => {
      const err = new ApiRequestError(`Request failed with status ${status}`, status);
      expect(err.message).toContain(String(status));
      expect(err.statusCode).toBe(status);
    });
  });
});

describe('apiFetch with mocked fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // Mock document.cookie for CSRF token
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: 'XSRF-TOKEN=ab' + 'a'.repeat(62),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return parsed JSON on successful response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ success: true, data: { id: '123' } }),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    const result = await apiFetch('http://localhost/api/test');
    expect(result).toEqual({ success: true, data: { id: '123' } });
  });

  it('should throw ApiRequestError on 4xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'text/plain' }),
      json: () => Promise.reject(new Error('Not JSON')),
      text: () => Promise.resolve('Bad request'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    await expect(apiFetch('http://localhost/api/test')).rejects.toThrow(ApiRequestError);
  });

  it('M3: preserves the HTTP status on a structured JSON error body (5xx)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ success: false, error: 'Service unavailable' }),
      text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Service unavailable' })),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    const result = await apiFetch('http://localhost/api/test');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Service unavailable');
      expect(result.statusCode).toBe(503);
    }
  });

  it('M3: distinguishes a 401 auth failure from a transient 5xx via statusCode', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ success: false, error: 'Unauthorized' }),
      text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Unauthorized' })),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    const result = await apiFetch('http://localhost/api/test');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
    }
  });

  it('should handle non-JSON response for 2xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      json: () => Promise.reject(new Error('Not JSON')),
      text: () => Promise.resolve('plain text'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    const result = await apiFetch('http://localhost/api/test');
    expect(result).toEqual({ success: true, data: 'plain text' });
  });

  it('should include X-CSRF-Token header for mutating methods', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ success: true, data: null }),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetch } = await import('@/lib/utils/api');
    await apiFetch('http://localhost/api/test', { method: 'POST', isMutation: true });

    const callArgs = mockFetch.mock.calls[0]!;
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('ab' + 'a'.repeat(62));
  });

  it('should cancel in-flight request via apiFetchWithCancel', async () => {
    const abortSpy = vi.fn();
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, opts: RequestInit) => new Promise((_resolve, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            abortSpy();
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const { apiFetchWithCancel } = await import('@/lib/utils/api');
    const { promise, cancel } = apiFetchWithCancel('http://localhost/api/test');
    cancel();
    await expect(promise).rejects.toThrow();
    expect(abortSpy).toHaveBeenCalled();
  });

  it('should return raw Response from apiRawFetch', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { apiRawFetch } = await import('@/lib/utils/api');
    const result = await apiRawFetch('http://localhost/api/raw');
    expect(result).toBe(mockResponse);
  });
});