import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRouter = { push: vi.fn() };
const mockQueryClient = { invalidateQueries: vi.fn() };
const mockSetSearchQuery = vi.fn();
const mockSetFilterGenre = vi.fn();
const mockAddToast = vi.fn();
const mockGenerate = vi.fn();
const mockReset = vi.fn();

const mockUseInfiniteStories = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));
vi.mock('@/lib/stores/app-store', () => ({
  useAppStore: (selector: any) => {
    const state = {
      searchQuery: '',
      setSearchQuery: mockSetSearchQuery,
      filterGenre: null,
      setFilterGenre: mockSetFilterGenre,
      addToast: mockAddToast,
    };
    return selector(state);
  },
}));
vi.mock('@/lib/query/stories', () => ({ useInfiniteStories: (...args: any[]) => mockUseInfiniteStories(...args) }));
vi.mock('@/hooks/use-generation', () => ({
  useGeneration: () => ({
    generate: mockGenerate,
    isGenerating: false,
    progress: null,
    error: null,
    reset: mockReset,
  }),
}));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('next/dynamic', () => {
  const ModalComponent = ({ isOpen, onClose, onGenerate }: any) =>
    isOpen ? (
      <div data-testid="generation-modal">
        <span>Generation Modal</span>
        <button onClick={() => onGenerate(['fantasy'], 'seed')}>Generate</button>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null;
  return { default: () => ModalComponent };
});

import DashboardPage from './page';

function createMockStory(overrides: Partial<any> = {}) {
  return {
    id: 'story-1',
    title: 'Test Story',
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

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('renders the heading', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn());
    render(<DashboardPage />);
    expect(screen.getByText('Story Dashboard')).toBeInTheDocument();
  });

  it('shows loading skeletons when isLoading is true', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({ isLoading: true }));
    render(<DashboardPage />);
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state when isError is true', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({ isError: true }));
    render(<DashboardPage />);
    expect(screen.getByText('Failed to load stories')).toBeInTheDocument();
  });

  it('shows empty state when no stories exist', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn());
    render(<DashboardPage />);
    expect(screen.getByText('No stories yet')).toBeInTheDocument();
    expect(screen.getByText('Create Your First Story')).toBeInTheDocument();
  });

  it('renders stories when data is available', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({
      stories: [
        createMockStory({ title: 'Story Alpha' }),
        createMockStory({ id: 'story-2', title: 'Story Beta' }),
      ],
      total: 2,
    }));
    render(<DashboardPage />);
    expect(screen.getByText('Story Alpha')).toBeInTheDocument();
    expect(screen.getByText('Story Beta')).toBeInTheDocument();
  });

  it('shows stats grid with story counts', () => {
    mockUseInfiniteStories.mockReturnValue(infiniteReturn({
      stories: [
        createMockStory({ episodes: [{ id: 'e1', scenes: [{ id: 's1' }] }] }),
      ],
      total: 1,
    }));
    render(<DashboardPage />);
    expect(screen.getByText('Total Stories')).toBeInTheDocument();
    expect(screen.getByText('Total Scenes')).toBeInTheDocument();
  });

  it('opens generation modal on Create Story click', async () => {
    const user = userEvent.setup();
    mockUseInfiniteStories.mockReturnValue(infiniteReturn());
    render(<DashboardPage />);

    await user.click(screen.getByText('Create Story'));
    expect(screen.getByTestId('generation-modal')).toBeInTheDocument();
  });
});
