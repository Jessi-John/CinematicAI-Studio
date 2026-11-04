import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';

describe('Button', () => {
  it('renders with default variant (primary) and size (md)', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: /click me/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('renders with secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole('button', { name: /secondary/i });
    expect(btn).toBeInTheDocument();
  });

  it('renders with ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole('button', { name: /ghost/i });
    expect(btn).toBeInTheDocument();
  });

  it('renders with danger variant', () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole('button', { name: /danger/i });
    expect(btn).toBeInTheDocument();
  });

  it('renders with sm size', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button', { name: /small/i })).toBeInTheDocument();
  });

  it('renders with lg size', () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button', { name: /large/i })).toBeInTheDocument();
  });

  it('shows loading spinner and disables when isLoading is true', () => {
    render(<Button isLoading>Loading</Button>);
    const btn = screen.getByRole('button', { name: /loading/i });
    expect(btn).toBeDisabled();
    // Loading spinner should be rendered (lucide Loader2 with animate-spin)
    const spinner = btn.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button', { name: /disabled/i })).toBeDisabled();
  });

  it('calls onClick handler when clicked', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Clickable</Button>);
    await userEvent.click(screen.getByRole('button', { name: /clickable/i }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when disabled', async () => {
    const handleClick = vi.fn();
    render(<Button disabled onClick={handleClick}>Disabled Click</Button>);
    await userEvent.click(screen.getByRole('button', { name: /disabled click/i }));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('accepts and applies additional className', () => {
    render(<Button className="extra-class">Styled</Button>);
    const btn = screen.getByRole('button', { name: /styled/i });
    expect(btn.className).toContain('extra-class');
  });

  it('renders children text correctly', () => {
    render(<Button>Submit Form</Button>);
    expect(screen.getByText('Submit Form')).toBeInTheDocument();
  });
});
