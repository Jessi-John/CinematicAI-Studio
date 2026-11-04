import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GenreSelector } from './genre-selector';

describe('GenreSelector', () => {
  const mockOnSelect = vi.fn();

  it('renders all genre buttons', () => {
    render(<GenreSelector selectedGenre={null} onSelect={mockOnSelect} />);
    // Should show the label
    expect(screen.getByText('Select Genre')).toBeInTheDocument();
    // Should render all 21 genres (emoji + label)
    expect(screen.getByText('Fantasy')).toBeInTheDocument();
    expect(screen.getByText('Adventure')).toBeInTheDocument();
    expect(screen.getByText('Horror')).toBeInTheDocument();
    expect(screen.getByText('Sci-Fi')).toBeInTheDocument();
    expect(screen.getByText('Anime-style')).toBeInTheDocument();
  });

  it('marks the selected genre visually', () => {
    render(<GenreSelector selectedGenre={'fantasy'} onSelect={mockOnSelect} />);
    const fantasyBtn = screen.getByText('Fantasy').closest('button');
    // The selected genre should have the purple border class
    expect(fantasyBtn?.className).toContain('border-purple-500');
  });

  it('does not mark non-selected genres', () => {
    render(<GenreSelector selectedGenre={'fantasy'} onSelect={mockOnSelect} />);
    const adventureBtn = screen.getByText('Adventure').closest('button');
    // Non-selected genres should have the default border
    expect(adventureBtn?.className).toContain('border-[var(--border)]');
  });

  it('calls onSelect with genre value when clicked', async () => {
    render(<GenreSelector selectedGenre={null} onSelect={mockOnSelect} />);
    await userEvent.click(screen.getByText('Mystery'));
    expect(mockOnSelect).toHaveBeenCalledWith('mystery');
  });

  it('renders with emoji icons for each genre', () => {
    render(<GenreSelector selectedGenre={null} onSelect={mockOnSelect} />);
    // Check for specific emoji icons
    expect(screen.getByText('🏰')).toBeInTheDocument(); // fantasy
    expect(screen.getByText('🚀')).toBeInTheDocument(); // sci-fi
    expect(screen.getByText('👻')).toBeInTheDocument(); // horror
  });

  it('marks the selected genre with aria-pressed', () => {
    render(<GenreSelector selectedGenre={'fantasy'} onSelect={mockOnSelect} />);
    const fantasyBtn = screen.getByText('Fantasy').closest('button');
    // aria-pressed exposes the selected state to assistive tech; the
    // aria-label is also genre-specific. These are the contract.
    expect(fantasyBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(fantasyBtn?.getAttribute('aria-label')).toBe('Select Fantasy genre');
    const adventureBtn = screen.getByText('Adventure').closest('button');
    expect(adventureBtn?.getAttribute('aria-pressed')).toBe('false');
  });
});
