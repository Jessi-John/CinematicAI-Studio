/**
 * L4-SETTINGS-SSR: Server Component wrapper for the settings page.
 *
 * Evaluation: This page has the best ratio of server-renderable content to
 * client interactivity. System health, story count, and user preferences are
 * read-heavy and benefit from immediate first paint. The interactive controls
 * (genre dropdown, auto-save toggle, refresh, cache clear, export) are
 * extracted into a client subcomponent because they need browser-only APIs
 * (localStorage, Blob downloads) or mutations with CSRF.
 *
 * The dashboard and create pages remain Client Components because they are
 * dominated by real-time interactivity (SSE progress, modals, debounced
 * search) and would gain no measurable benefit from SSR. The history page
 * remains a Client Component because its filter state lives in shared Zustand
 * state rather than URL params; server-rendering it would cause a hydration
 * flash when the client re-fetches with the active filter.
 */
import { redirect } from 'next/navigation';
import { serverApiFetch, ServerApiError } from '@/lib/utils/server-api';
import SettingsClient, {
  type HealthStatus,
  type UserSetting,
} from './settings-client';

export const dynamic = 'force-dynamic';

export default async function SettingsPage(): Promise<React.ReactElement> {
  let health: HealthStatus | undefined;
  let stories: { total: number } | undefined;
  let settings: UserSetting[] | undefined;

  try {
    [health, stories, settings] = await Promise.all([
      serverApiFetch<HealthStatus>('/api/health'),
      serverApiFetch<{ total: number }>('/api/stories?limit=1'),
      serverApiFetch<UserSetting[]>('/api/user-settings'),
    ]);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 401) {
      redirect('/login?msg=Please+sign+in+to+access+that+page');
    }
    throw error;
  }

  return (
    <SettingsClient
      initialHealth={health}
      initialStoriesCount={stories?.total ?? 0}
      initialUserSettings={settings ?? []}
    />
  );
}
