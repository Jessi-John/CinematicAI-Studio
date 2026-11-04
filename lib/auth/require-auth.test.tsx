import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const mockPush = vi.fn();
const mockUseAuth = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/protected',
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

import { RequireAuth } from '@/lib/auth/require-auth';

function Protected() {
  return <div data-testid="protected">Protected Content</div>;
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing while auth is loading', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
    const { container } = render(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders children when authenticated and not loading', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    render(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );
    expect(screen.getByTestId('protected')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('redirects to /login when not authenticated and not loading', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    render(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('http://localhost:3000/login?from=%2Fprotected');
    });
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('does not redirect while loading even if unauthenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
    render(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('redirects exactly once when state transitions from loading to unauthenticated', async () => {
    const authState: { isAuthenticated: boolean; isLoading: boolean } = {
      isAuthenticated: false,
      isLoading: true,
    };
    mockUseAuth.mockImplementation(() => ({ ...authState }));

    const { rerender } = render(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );
    expect(mockPush).not.toHaveBeenCalled();

    authState.isLoading = false;
    rerender(
      <RequireAuth>
        <Protected />
      </RequireAuth>
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('http://localhost:3000/login?from=%2Fprotected');
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});
