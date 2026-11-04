/**
 * L4-FRONTEND-SSR: server component wrapper for the story detail page.
 *
 * The original page.tsx was a 'use client' component that fetched its
 * data on mount. Crawlers, link-preview bots, and the browser's
 * "view source" / "save page" all saw an empty <main> element because
 * the data only arrived after JS hydration. The fix is to fetch the
 * story on the server (with the user's auth cookies forwarded) and
 * pass the result as `initialStory` to a client subcomponent that
 * renders the interactive UI.
 *
 * Why a server fetch (not just a static seed)? The story content is
 * user-private — the route lives under (dashboard) and the proxy
 * requires a valid JWT cookie. Server-side fetch needs to
 * forward the cookie to the backend so the request is authenticated.
 *
 * If the server fetch fails (backend 500, network blip, or a mocked ID
 * in E2E tests), we do NOT call notFound(). Instead we render the
 * client component without an initial story so it can retry on the
 * client. Real stories get server-rendered HTML; test mocks and
 * transient outages fall back to the same client path a pure CSR app
 * would use.
 */
import { redirect } from 'next/navigation';
import { serverApiFetch, ServerApiError } from '@/lib/utils/server-api';
import type { Story } from '@/types';
import StoryDetailClient from './story-detail-client';

// Force dynamic rendering — every story detail page is per-user
// private data. Without this directive Next.js may try to statically
// pre-render at build time, which would emit the page without the
// user's cookie and surface a 401 from the backend.
export const dynamic = 'force-dynamic';

export default async function StoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  let initialStory: Story | undefined;

  try {
    initialStory = await serverApiFetch<Story>(`/api/stories/${id}`);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 401) {
      redirect('/login?msg=Please+sign+in+to+access+that+page');
    }
    // Other failures render the client component without an initial story so
    // it can retry on the client (matches the original fallback behavior).
  }

  return <StoryDetailClient initialStory={initialStory} />;
}
