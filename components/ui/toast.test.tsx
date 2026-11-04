import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastContainer } from './toast';
import { useAppStore } from '@/lib/stores/app-store';

// Helper to reset the store between tests
function resetStore() {
  const { getState, setState } = useAppStore;
  setState({
    ...getState(),
    toasts: [],
  });
}

describe('ToastContainer', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    // The container div should be rendered but empty
    expect(container.querySelector('.fixed')).toBeInTheDocument();
    // No toast items should be visible
    expect(container.querySelector('.animate-slide-in-right')).not.toBeInTheDocument();
  });

  it('renders toast items from the store', () => {
    useAppStore.getState().addToast('success', 'Operation completed');
    useAppStore.getState().addToast('error', 'Something went wrong');

    render(<ToastContainer />);

    expect(screen.getByText('Operation completed')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders info type toasts', () => {
    useAppStore.getState().addToast('info', 'Informational message');
    render(<ToastContainer />);
    expect(screen.getByText('Informational message')).toBeInTheDocument();
  });

  it('calls removeToast when close button is clicked', async () => {
    const removeToastSpy = vi.spyOn(useAppStore.getState(), 'removeToast');
    useAppStore.getState().addToast('success', 'Dismiss me');

    render(<ToastContainer />);

    // Find and click the close button (X icon button)
    const closeBtn = screen.getByRole('button');
    await userEvent.click(closeBtn);

    expect(removeToastSpy).toHaveBeenCalled();
  });

  it('renders multiple toasts and positions them correctly', () => {
    useAppStore.getState().addToast('success', 'First toast');
    useAppStore.getState().addToast('error', 'Second toast');
    useAppStore.getState().addToast('info', 'Third toast');

    const { container } = render(<ToastContainer />);

    // All three toasts should be rendered
    expect(screen.getByText('First toast')).toBeInTheDocument();
    expect(screen.getByText('Second toast')).toBeInTheDocument();
    expect(screen.getByText('Third toast')).toBeInTheDocument();

    // The container should have the fixed positioning class
    const toastContainer = container.querySelector('.fixed.top-4.right-4');
    expect(toastContainer).toBeInTheDocument();
    // Should have the flex-col layout for vertical stacking
    expect(toastContainer?.className).toContain('flex-col');
  });

  it('removes a toast from the store when close is clicked', async () => {
    useAppStore.getState().addToast('success', 'Click to dismiss');
    render(<ToastContainer />);

    expect(screen.getByText('Click to dismiss')).toBeInTheDocument();

    // Click the close button
    const closeBtn = screen.getByRole('button');
    await userEvent.click(closeBtn);

    // The toast should be removed from the store
    expect(useAppStore.getState().toasts.length).toBe(0);
  });

  it('splits toasts into assertive (error) and polite (non-error) live regions', () => {
    useAppStore.getState().addToast('error', 'Error toast');
    useAppStore.getState().addToast('success', 'Success toast');

    const { container } = render(<ToastContainer />);

    const assertive = container.querySelector('[aria-live="assertive"]');
    const polite = container.querySelector('[aria-live="polite"]');
    expect(assertive).not.toBeNull();
    expect(polite).not.toBeNull();
    // Error lives in the assertive region, success in the polite region.
    expect(assertive?.textContent).toContain('Error toast');
    expect(assertive?.textContent).not.toContain('Success toast');
    expect(polite?.textContent).toContain('Success toast');
    expect(polite?.textContent).not.toContain('Error toast');
  });

  it('keeps both live regions in a single positioned wrapper (no overlap)', () => {
    useAppStore.getState().addToast('error', 'Error toast');
    useAppStore.getState().addToast('success', 'Success toast');

    const { container } = render(<ToastContainer />);

    // Exactly one fixed-position wrapper holds both regions, so an error and a
    // success toast can never be painted on top of each other.
    const wrappers = container.querySelectorAll('.fixed.top-4.right-4');
    expect(wrappers.length).toBe(1);
    expect(wrappers[0]!.querySelector('[aria-live="assertive"]')).not.toBeNull();
    expect(wrappers[0]!.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('shows only the last MAX_TOASTS (5) toasts', () => {
    for (let i = 1; i <= 7; i += 1) {
      useAppStore.getState().addToast('info', `Toast ${i}`);
    }

    render(<ToastContainer />);

    // The oldest two are sliced off; only the most recent five render.
    expect(screen.queryByText('Toast 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Toast 2')).not.toBeInTheDocument();
    for (let i = 3; i <= 7; i += 1) {
      expect(screen.getByText(`Toast ${i}`)).toBeInTheDocument();
    }
  });

  describe('auto-dismiss timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes a toast automatically after the duration elapses', async () => {
      useAppStore.getState().addToast('success', 'Auto dismiss me');
      render(<ToastContainer />);

      expect(screen.getByText('Auto dismiss me')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(screen.queryByText('Auto dismiss me')).not.toBeInTheDocument();
      expect(useAppStore.getState().toasts.length).toBe(0);
    });
  });
});
