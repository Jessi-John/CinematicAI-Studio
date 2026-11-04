import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Modal } from './modal';

describe('Modal', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('renders content when isOpen is true', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render content when isOpen is false', () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()}>
        <p>Should not be visible</p>
      </Modal>
    );
    expect(screen.queryByText('Should not be visible')).not.toBeInTheDocument();
  });

  it('renders the title when provided', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Title">
        <p>Content</p>
      </Modal>
    );
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('calls onClose when clicking the backdrop', async () => {
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose}>
        <p>Content</p>
      </Modal>
    );
    // Click the backdrop (the first motion.div with fixed inset-0)
    const backdrop = document.querySelector('.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    if (backdrop) {
      await userEvent.click(backdrop);
      expect(handleClose).toHaveBeenCalledTimes(1);
    }
  });

  it('calls onClose when pressing Escape key', async () => {
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose}>
        <p>Content</p>
      </Modal>
    );
    await userEvent.keyboard('{Escape}');
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('prevents body scroll when open', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body scroll when closed', () => {
    const { rerender } = render(
      <Modal isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    rerender(
      <Modal isOpen={false} onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('');
  });

  it('exposes dialog semantics and aria-labelledby when titled', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Accessible Title">
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const title = screen.getByText('Accessible Title');
    expect(dialog).toHaveAttribute('aria-labelledby', title.id);
  });

  it('uses aria-label when title is absent and ariaLabel is provided', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} ariaLabel="Accessible Label">
        <p>Content</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'Accessible Label');
    expect(dialog).not.toHaveAttribute('aria-labelledby');
  });

  it('restores focus to the trigger element on close', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    function Test() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal isOpen={open} onClose={() => { handleClose(); setOpen(false); }}>
            <button>Inside</button>
          </Modal>
        </>
      );
    }
    render(<Test />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });
});


