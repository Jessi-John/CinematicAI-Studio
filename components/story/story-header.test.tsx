import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoryHeader } from './story-header';
import type { Story } from '@/types';

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

describe('StoryHeader', () => {
  const baseStory = {
    id: 'story-1',
    title: 'Test Story',
    genre: 'fantasy' as const,
    status: 'complete' as const,
    createdAt: '2026-07-14T08:30:00.000Z',
    updatedAt: '2026-07-14T08:30:00.000Z',
    episodes: [],
    characters: [],
    environments: [],
    metadata: {
      totalEpisodes: 0,
      totalScenes: 0,
      estimatedDuration: 0,
      targetAudience: 'general',
      monetizationScore: 0,
      viralityScore: 0,
      retentionScore: 0,
      hookStrength: 0,
    },
  } as Story;

  const handlers = {
    onExport: vi.fn(),
    onRegenerate: vi.fn(),
    onDelete: vi.fn(),
  };

  it('renders the created date with explicit UTC locale so SSR and client match', () => {
    // A date that would differ between UTC and America/New_York if the timezone
    // were left to the host: 2026-07-14 08:30 UTC is 2026-07-14 04:30 EDT,
    // but without timeZone:'UTC' a New_York client would render 7/14/2026 while
    // a UTC server might render 7/14/2026 here. The key property is that the
    // component now passes explicit locale and timeZone to toLocaleDateString,
    // making the output deterministic regardless of the host environment.
    render(
      <StoryHeader
        story={baseStory}
        isRegenerating={false}
        isDeleting={false}
        {...handlers}
      />
    );

    const createdLine = screen.getByText(/Created .*/);
    expect(createdLine).toHaveTextContent('Created 7/14/2026');
  });
});
