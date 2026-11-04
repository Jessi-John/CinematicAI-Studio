import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockAddToast = vi.fn();
const mockApiFetch = vi.fn();

vi.mock('@/lib/stores/app-store', () => ({
  useAppStore: (selector: any) => selector({ addToast: mockAddToast }),
}));
vi.mock('@/lib/utils/api', () => ({ apiFetch: (...args: any[]) => mockApiFetch(...args) }));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ user: { id: 'admin-1', username: 'admin', role: 'admin' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: any) => <span {...props}>{children}</span>,
    h1: ({ children, ...props }: any) => <h1 {...props}>{children}</h1>,
    h2: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
    h3: ({ children, ...props }: any) => <h3 {...props}>{children}</h3>,
    p: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

import AdminPage from './page';

const healthResponse = {
  success: true,
  data: {
    status: 'healthy',
    services: { database: 'connected', redis: 'connected' },
    version: '1.0.0',
    uptime: 3600,
  },
};

const queueResponse = {
  success: true,
  data: {
    queueDepth: 5,
    activeJobs: 2,
    completedToday: 10,
    dlqDepth: 1,
    recentFailures: [
      {
        jobId: 'fail-12345678-1234-1234-1234-123456789abc',
        genre: ['fantasy'],
        failedAt: Date.now() - 300000,
        failedReason: 'API timeout',
        attemptsMade: 3,
      },
    ],
  },
};

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch
      .mockResolvedValueOnce(healthResponse)
      .mockResolvedValueOnce(queueResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    });
  });

  it('displays service health data after loading', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('healthy')).toBeInTheDocument();
    });
    const connectedBadges = screen.getAllByText('connected');
    expect(connectedBadges.length).toBe(2);
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
  });

  it('displays queue overview', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('Queue Overview')).toBeInTheDocument();
    });
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('displays recent failures in DLQ section', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('Recent Failures')).toBeInTheDocument();
    });
    expect(screen.getByText('API timeout')).toBeInTheDocument();
    expect(screen.getByText('3 attempts')).toBeInTheDocument();
  });

  it('shows refresh button', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('fetches data on mount', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('http://localhost:34567/api/health');
      expect(mockApiFetch).toHaveBeenCalledWith('http://localhost:34567/api/admin/queue');
    });
  });

  it('shows "no failures" when DLQ is empty', async () => {
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce(healthResponse)
      .mockResolvedValueOnce({
        success: true,
        data: {
          queueDepth: 0,
          activeJobs: 0,
          completedToday: 0,
          dlqDepth: 0,
          recentFailures: [],
        },
      });

    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('No recent failures — all jobs healthy')).toBeInTheDocument();
    });
  });

  it('handles refresh button click', async () => {
    const user = userEvent.setup();
    mockApiFetch
      .mockReset()
      .mockResolvedValueOnce(healthResponse)
      .mockResolvedValueOnce(queueResponse);

    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    mockApiFetch
      .mockResolvedValueOnce(healthResponse)
      .mockResolvedValueOnce(queueResponse);

    await user.click(screen.getByText('Refresh'));
    expect(mockApiFetch).toHaveBeenCalledTimes(4);
  });

  it('displays uptime', async () => {
    render(<AdminPage />);
    await waitFor(() => {
      expect(screen.getByText(/Uptime/)).toBeInTheDocument();
    });
    expect(screen.getByText(/60m/)).toBeInTheDocument();
  });
});
