import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from './page';

const mockRouter = { push: vi.fn() };
const mockLogin = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

describe('LoginPage', () => {
  it('renders the redirected flash message from the query string', () => {
    // Reading query params in a hydration-safe way means the banner must still
    // render on the client when window.location.search contains a msg.
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?msg=Session+expired' },
      configurable: true,
    });

    render(<LoginPage />);

    expect(screen.getByText('Session expired')).toBeInTheDocument();
  });

  it('renders no flash message when the query string is empty', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '' },
      configurable: true,
    });

    render(<LoginPage />);

    expect(screen.queryByText('Please sign in to continue')).not.toBeInTheDocument();
  });
});
