import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockQueryClient = { invalidateQueries: vi.fn() };
const mockSetSearchQuery = vi.fn();
const mockSetFilterGenre = vi.fn();
const mockUseInfiniteStories = vi.fn();

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));
vi.mock('@/lib/stores/app-store', () => ({
  useAppStore: (selector: any) => {
    const state = {
      searchQuery: '',
      setSearchQuery: mockSetSearchQuery,
      filterGenre: null,
      setFilterGenre: mockSetFilterGenre,
    };
    return selector(state);
  },
}));
vi.mock('@/lib/query/stories', () => ({ useInfiniteStories: (...args: any[]) => mockUseInfiniteStories(...args) }));
vi.mock('@/lib/constants/genres', () => ({
  GENRES: [
    { value: 'fantasy', label: 'Fantasy', emoji: '🏰' },
    { value: 'adventure', label: 'Adventure', emoji: '🗺️' },
  ],
  GENRE_MAP: {
    fantasy: { value: 'fantasy', label: 'Fantasy', emoji: '🏰' },
    adventure: { value: 'adventure', label: 'Adventure', emoji: '🗺️' },
  },
  STORY_COLORS: { fantasy: '#7b5ea7', adventure: '#e8a838' },
}));
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a> }));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    h1: ({ children, ...props }: any) => <h1 {...props}>{children}</h1>,
    p: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

import HistoryPage from './page';

function createMockStory(overrides: any = {}) {
  return {
    id: 'story-1',
    title: 'History Story',
    genre: 'fantasy',
    status: 'complete',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    episodes: [],
    characters: [],
    environments: [],
    metadata: { totalEpisodes: 10, totalScenes: 50, estimatedDuration: 500, targetAudience: '', monetizationScore: 85, viralityScore: 85, retentionScore: 88, hookStrength: 90 },
    ...overrides,
  };
}

describe('HistoryPage', () => {
  function infiniteReturn(overrides: any = {}) {
    return {
      stories: [] as any[],
      total: 0,
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({ stories: [createMockStory()], total: 1 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading', () => {
    render(<HistoryPage />);
    expect(screen.getByText('Generated Stories')).toBeInTheDocument();
  });

  it('shows loading skeletons', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({ isLoading: true }));
    render(<HistoryPage />);
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({ isError: true }));
    render(<HistoryPage />);
    expect(screen.getByText('Failed to load stories')).toBeInTheDocument();
  });

  it('shows empty state with link to create', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn());
    render(<HistoryPage />);
    expect(screen.getByText('No stories found')).toBeInTheDocument();
    expect(screen.getByText('Create New Story')).toBeInTheDocument();
  });

  it('renders stories when available', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({
      stories: [
        createMockStory({ title: 'Story One' }),
        createMockStory({ id: 'story-2', title: 'Story Two' }),
      ],
      total: 2,
    }));
    render(<HistoryPage />);
    expect(screen.getByText('Story One')).toBeInTheDocument();
    expect(screen.getByText('Story Two')).toBeInTheDocument();
  });

  it('shows story count', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({
      stories: [createMockStory(), createMockStory({ id: 'story-2' })],
      total: 2,
    }));
    render(<HistoryPage />);
    expect(screen.getByText('2 stories found')).toBeInTheDocument();
  });

  it('shows correct plural for 1 story', () => {
    render(<HistoryPage />);
    expect(screen.getByText('1 story found')).toBeInTheDocument();
  });

  it('search input is rendered', () => {
    render(<HistoryPage />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('M41: passes sort selection to useInfiniteStories for server-side sorting', async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    const select = screen.getByLabelText('Sort stories');
    await user.selectOptions(select, 'oldest');
    expect(mockUseInfiniteStories).toHaveBeenLastCalledWith('', null, 'oldest');
    expect(screen.getByRole('option', { name: 'Oldest First' })).toBeInTheDocument();
  });
});
