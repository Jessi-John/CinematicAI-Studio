import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsClient from '@/app/(dashboard)/settings/settings-client';

const { mockAddToast, mockApiFetch } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/utils/api', () => ({ apiFetch: mockApiFetch }));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('@/lib/stores/app-store', () => ({
  // The component uses a selector (useAppStore((s) => s.addToast)) — apply it.
  useAppStore: (selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));
// framer-motion injects runtime styles jsdom cannot lay out; render sections
// as plain divs (same approach as app/(dashboard)/story/[id]/page.test.tsx).
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: () => {
        const Component = ({ children, ...props }: any) => <div {...props}>{children}</div>;
        Component.displayName = 'motion';
        return Component;
      },
    }
  ),
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

const baseProps = {
  initialHealth: {
    status: 'ok',
    services: { database: 'up', redis: 'up' },
    version: '1.0.0',
    uptime: 120,
  } as import('@/app/(dashboard)/settings/settings-client').HealthStatus,
  initialStoriesCount: 42,
  initialUserSettings: [
    { key: 'preferred_genre', value: 'fantasy', type: 'string' as const },
    { key: 'auto_save_generations', value: 'true', type: 'string' as const },
  ] as import('@/app/(dashboard)/settings/settings-client').UserSetting[],
};

describe('SettingsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the settings sections with SSR-provided initial data', () => {
    render(<SettingsClient {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'Settings' }).tagName).toBe('H1');
    expect(screen.getByRole('heading', { name: 'User Preferences' }).textContent).toBe('User Preferences');
    expect(screen.getByRole('heading', { name: 'System Status' }).textContent).toBe('System Status');

    // Initial values come from server-side settings, not fetches.
    // The genre <select> options are labelled in Title Case (Fantasy).
    expect((screen.getByLabelText(/Default genre/i) as HTMLSelectElement).value).toBe('fantasy');
    const autoSaveSwitch = screen.getByRole('switch', { name: /auto-save/i });
    expect((autoSaveSwitch as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
  });

  it('refreshes health and story count from the API on Refresh click', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/health')) {
        return {
          success: true,
          data: { status: 'ok', services: { database: 'up', redis: 'down' }, version: '1.0.0' },
        };
      }
      if (url.includes('/api/stories')) {
        return { success: true, data: { total: 99 } };
      }
      return { success: false, error: 'unexpected url' };
    });

    render(<SettingsClient {...baseProps} />);
    await user.click(screen.getByRole('button', { name: /Refresh/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
    });
    // The refreshed values replace the initial ones without a full reload
    // (M43: no full-page spinner on manual refresh).
    await waitFor(() => {
      expect(screen.getByText('99').textContent).toBe('99');
    });
  });

  it('rolls the preferred-genre select back when the save fails', async () => {
    mockApiFetch.mockResolvedValueOnce({ success: false, error: 'Save failed' });

    render(<SettingsClient {...baseProps} />);
    const select = screen.getByLabelText(/Default genre/i) as HTMLSelectElement;

    await act(async () => {
      select.value = 'comedy';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith('error', expect.stringMatching(/failed/i));
    });
    // Optimistic update reverted to the initial genre after the failed PUT.
    await waitFor(() => {
      expect((screen.getByLabelText(/Default genre/i) as HTMLSelectElement).value).toBe('fantasy');
    });
  });
});
