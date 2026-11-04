import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { Modal } from '@/components/ui/modal';
import { ToastContainer } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/stores/app-store';

describe('axe accessibility smoke tests', () => {
  beforeEach(() => {
    // M50: populate the store in setup, NOT during render (render-phase side
    // effects are illegal React and leaked toasts + 5s timers outlived tests).
    useAppStore.setState({ toasts: [] });
    useAppStore.getState().addToast('error', 'Test error');
    useAppStore.getState().addToast('info', 'Test info');
  });

  afterEach(() => {
    useAppStore.setState({ toasts: [] });
  });

  it('modal has no critical or serious accessibility violations', async () => {
    const { container } = render(
      <Modal isOpen={true} onClose={() => {}} title="Test Modal">
        <button type="button">Action</button>
      </Modal>
    );
    const results = await axe.run(container);
    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(severe).toHaveLength(0);
  });

  it('button has no critical or serious accessibility violations', async () => {
    const { container } = render(<Button>Click me</Button>);
    const results = await axe.run(container);
    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(severe).toHaveLength(0);
  });

  it('toast container has no critical or serious accessibility violations', async () => {
    const { container } = render(<ToastContainer />);
    const results = await axe.run(container);
    const severe = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    expect(severe).toHaveLength(0);
  });
});
