/**
 * L4-SERVER-API: authenticated server-side fetch helper.
 *
 * Next.js Server Components cannot use the browser's `apiFetch` wrapper
 * because they run before hydration and must forward the user's auth
 * cookies to the backend directly. This helper centralizes that pattern
 * so server pages don't inline raw fetch calls and don't need per-file
 * lint overrides.
 *
 * It always bypasses Next.js's fetch cache (`cache: 'no-store'`) because
 * the data is private and mutation-heavy.
 */
import { cookies, headers } from 'next/headers';
import type { ApiResponse } from '@/types';

export class ServerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly kind: 'config' | 'network' | 'backend'
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

function getExpressApiBase(): string {
  const url = process.env.API_BASE_URL;
  if (!url) {
    throw new ServerApiError('API_BASE_URL is not configured', null, 'config');
  }
  return url;
}

export async function serverApiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;
  const cookieHeader = token ? `access_token=${token}` : '';
  const forwardedHeaders = await headers();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Backend request timed out')), 15_000);

  try {
    const res = await fetch(`${getExpressApiBase()}${path}`, {
      signal: controller.signal,
      cache: 'no-store',
      ...init,
      headers: {
        accept: 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        'x-forwarded-host': forwardedHeaders.get('host') ?? 'localhost:3000',
        'x-forwarded-proto': forwardedHeaders.get('x-forwarded-proto') ?? 'http',
        // Forward the request ID so backend logs correlate with frontend requests.
        ...(forwardedHeaders.get('x-request-id') ? { 'x-request-id': forwardedHeaders.get('x-request-id')! } : {}),
        ...(init.headers ?? {}),
      },
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new ServerApiError(`Backend returned ${res.status}`, res.status, 'backend');
    }
    const data = (await res.json()) as ApiResponse<T>;
    // Unwrap the ApiResponse envelope to return the nested data object
    if (!data.success) {
      throw new ServerApiError(data.error || 'Backend reported failure', null, 'backend');
    }
    return data.data as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof ServerApiError) {
      throw error;
    }
    throw new ServerApiError(
      error instanceof Error ? error.message : 'Backend request failed',
      null,
      'network'
    );
  }
}
