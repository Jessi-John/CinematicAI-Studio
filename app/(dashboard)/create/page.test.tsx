import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRouter = { push: vi.fn() };
const mockQueryClient = { invalidateQueries: vi.fn() };
const mockAddToast = vi.fn();
const mockGenerate = vi.fn();
const mockReset = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));
vi.mock('@/lib/stores/app-store', () => ({
  useAppStore: (selector: any) => selector({ addToast: mockAddToast }),
}));

const mockUseGeneration = vi.fn();
vi.mock('@/hooks/use-generation', () => ({ useGeneration: (...args: any[]) => mockUseGeneration(...args) }));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('@/lib/constants/genres', () => ({
  GENRES: [{ value: 'fantasy', label: 'Fantasy', emoji: '🏰' }],
  isValidGenre: (g: string) => g === 'fantasy',
  STORY_COLORS: { fantasy: '#7b5ea7' },
}));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    h1: ({ children, ...props }: any) => <h1 {...props}>{children}</h1>,
    p: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/generation/genre-selector', () => ({
  GenreSelector: ({ onSelect }: any) => (
    <div data-testid="genre-selector">
      <button onClick={() => onSelect('fantasy')} data-testid="genre-fantasy">🏰 Fantasy</button>
    </div>
  ),
}));
vi.mock('@/components/generation/seed-input', () => ({
  SeedInput: ({ value, onChange }: any) => (
    <input data-testid="seed-input" value={value} onChange={(e: any) => onChange(e.target.value)} placeholder="Enter a story seed" />
  ),
}));
vi.mock('@/components/generation/generation-preview', () => ({
  GenerationPreview: ({ story, onViewStory }: any) => (
    <div data-testid="generation-preview">
      <h2>{story.title}</h2>
      <button onClick={onViewStory}>View Full Story</button>
    </div>
  ),
}));

import CreatePage from './page';

const defaultGenerationState = {
  generate: mockGenerate,
  isGenerating: false,
  progress: null,
  error: null,
  generatedStory: null,
  reset: mockReset,
};

describe('CreatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGeneration.mockReturnValue(defaultGenerationState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading and description', () => {
    render(<CreatePage />);
    expect(screen.getByText('Create New Story')).toBeInTheDocument();
    expect(screen.getByText(/Generate a unique cinematic story/)).toBeInTheDocument();
  });

  it('renders genre selector', () => {
    render(<CreatePage />);
    expect(screen.getByTestId('genre-selector')).toBeInTheDocument();
  });

  it('shows seed input', () => {
    render(<CreatePage />);
    expect(screen.getByTestId('seed-input')).toBeInTheDocument();
  });

  it('shows generate button', () => {
    render(<CreatePage />);
    expect(screen.getByRole('button', { name: /Generate Story/ })).toBeInTheDocument();
  });

  it('generate button is disabled when no genre selected', () => {
    render(<CreatePage />);
    expect(screen.getByRole('button', { name: /Generate Story/ })).toBeDisabled();
  });

  it('selecting a genre enables generate button', async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.click(screen.getByTestId('genre-fantasy'));
    expect(screen.getByRole('button', { name: /Generate Story/ })).not.toBeDisabled();
  });

  it('calls generate when button clicked', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue(undefined);
    render(<CreatePage />);

    await user.click(screen.getByTestId('genre-fantasy'));
    await user.click(screen.getByRole('button', { name: /Generate Story/ }));

    expect(mockGenerate).toHaveBeenCalledWith({ genre: ['fantasy'], seed: undefined });
  });

  it('shows generating state', () => {
    mockUseGeneration.mockReturnValue({
      ...defaultGenerationState,
      isGenerating: true,
      progress: { stage: 'blueprint', progress: 42, message: 'Creating blueprint...', totalSteps: 10, completedSteps: 4 },
    });
    render(<CreatePage />);
    expect(screen.getByText('Generating Story')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows error state', () => {
    mockUseGeneration.mockReturnValue({
      ...defaultGenerationState,
      error: 'API quota exceeded',
    });
    render(<CreatePage />);
    expect(screen.getByText('Generation Failed')).toBeInTheDocument();
    expect(screen.getByText('API quota exceeded')).toBeInTheDocument();
  });

  it('shows generated story preview on success', () => {
    mockUseGeneration.mockReturnValue({
      ...defaultGenerationState,
      generatedStory: {
        id: 'story-42',
        title: 'My Fantasy Tale',
        genre: 'fantasy',
        status: 'complete',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        episodes: [],
        characters: [],
        environments: [],
        metadata: { totalEpisodes: 10, totalScenes: 50, estimatedDuration: 500, targetAudience: '', monetizationScore: 85, viralityScore: 85, retentionScore: 88, hookStrength: 90 },
      },
    });
    render(<CreatePage />);
    expect(screen.getByText('My Fantasy Tale')).toBeInTheDocument();
    expect(screen.getByText('story-42')).toBeInTheDocument();
  });

  it('does not show generate button when generating', () => {
    mockUseGeneration.mockReturnValue({
      ...defaultGenerationState,
      isGenerating: true,
    });
    render(<CreatePage />);
    expect(screen.queryByRole('button', { name: /Generate Story/ })).toBeNull();
  });

  it('does not show genre selector when story is generated', () => {
    mockUseGeneration.mockReturnValue({
      ...defaultGenerationState,
      generatedStory: {
        id: 'story-42',
        title: 'My Fantasy Tale',
        genre: 'fantasy',
        status: 'complete',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        episodes: [],
        characters: [],
        environments: [],
        metadata: { totalEpisodes: 10, totalScenes: 50, estimatedDuration: 500, targetAudience: '', monetizationScore: 85, viralityScore: 85, retentionScore: 88, hookStrength: 90 },
      },
    });
    render(<CreatePage />);
    expect(screen.queryByTestId('genre-selector')).toBeNull();
  });
});
