import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GenerationModal } from './generation-modal';

describe('GenerationModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onGenerate: vi.fn(),
    isGenerating: false,
    progress: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onClose when the X button is clicked while not generating', async () => {
    render(<GenerationModal {...defaultProps} />);

    const closeBtn = screen.getByRole('button', { name: 'Close modal' });
    await userEvent.click(closeBtn);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    expect(defaultProps.onMinimize).not.toHaveBeenCalled();
  });

  it('calls onMinimize, not onClose, when the minimize button is clicked while generating', async () => {
    render(<GenerationModal {...defaultProps} isGenerating={true} progress={{ stage: 'building', message: 'Generating', progress: 50, totalSteps: 5, completedSteps: 2 }} />);

    const minimizeBtn = screen.getByRole('button', { name: 'Minimize to background' });
    await userEvent.click(minimizeBtn);

    expect(defaultProps.onMinimize).toHaveBeenCalledTimes(1);
    // The parent intentionally blocks onClose during generation; the minimize
    // button must use the dedicated path so it actually works.
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('M40: highlights backend-only stages such as world_bible in the progress tracker', () => {
    render(
      <GenerationModal
        {...defaultProps}
        isGenerating={true}
        progress={{
          stage: 'world_bible',
          message: 'Designing world and supporting cast...',
          progress: 18,
          totalSteps: 16,
          completedSteps: 5,
        }}
      />
    );

    expect(screen.getByText('World Bible')).toBeInTheDocument();
    expect(screen.getByText('Designing world and supporting cast...')).toBeInTheDocument();
    const activeStep = screen.getByText('World Bible').closest('[aria-current="step"]');
    expect(activeStep).toBeInTheDocument();
  });
});
