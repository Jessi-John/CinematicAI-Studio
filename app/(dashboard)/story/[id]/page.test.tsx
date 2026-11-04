import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRouter = { push: vi.fn() };
const mockQueryClient = { invalidateQueries: vi.fn(), removeQueries: vi.fn() };
const mockAddToast = vi.fn();
const mockDeleteMutate = vi.fn();
const mockRegenMutate = vi.fn();
const mockRegenEpMutate = vi.fn();

const mockUseStory = vi.fn();
const mockUseDeleteStory = vi.fn();
const mockUseRegenerateStory = vi.fn();
const mockUseRegenerateEpisode = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({ id: 'story-123' }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));
vi.mock('@/lib/stores/app-store', () => ({
  useAppStore: (selector: any) => selector({ addToast: mockAddToast }),
}));
vi.mock('@/lib/query/stories', () => ({
  useStory: (...args: any[]) => mockUseStory(...args),
  useDeleteStory: (...args: any[]) => mockUseDeleteStory(...args),
  useRegenerateStory: (...args: any[]) => mockUseRegenerateStory(...args),
}));
vi.mock('@/lib/query/analytics', () => ({
  useRegenerateEpisode: (...args: any[]) => mockUseRegenerateEpisode(...args),
}));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('@/lib/constants/genres', () => ({
  GENRES: [{ value: 'fantasy', label: 'Fantasy', emoji: '🏰' }],
  GENRE_MAP: { fantasy: { value: 'fantasy', label: 'Fantasy', emoji: '🏰' } },
  STORY_COLORS: { fantasy: '#7b5ea7' },
  isValidGenre: (g: string) => g === 'fantasy',
}));
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a> }));
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: () => {
        const Component = ({ children, layoutId: _layoutId, ...props }: any) => <div {...props}>{children}</div>;
        Component.displayName = 'motion';
        return Component;
      },
    }
  ),
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));
vi.mock('@/lib/utils/api', () => ({ apiRawFetch: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/components/story/episode-card', () => ({ EpisodeCard: ({ episode }: any) => <div data-testid="episode-card">{episode.title}</div> }));
vi.mock('@/components/story/inline-editor', () => ({ InlineEditor: () => <div data-testid="inline-editor" /> }));
vi.mock('@/components/ui/modal', () => ({
  // M57: mirror the real Modal's close semantics (backdrop click / Escape /
  // X button) — closing on ANY content click masked propagation bugs.
  Modal: ({ isOpen, children, onClose }: any) =>
    isOpen ? (
      <div data-testid="modal">
        <div data-testid="modal-backdrop" onClick={onClose} />
        <button aria-label="Close modal" onClick={onClose}>x</button>
        {children}
      </div>
    ) : null,
}));

import StoryPage from './story-detail-client';

function makePrompt(content: string) {
  return { id: 'p-1', type: 'image' as const, content, version: 1, createdAt: '2024-01-01T00:00:00.000Z' };
}

function makeScene(id: string, num: number) {
  return {
    id,
    number: num,
    duration: 30,
    narration: { id: 'n-1', text: 'Narration text', timing: { totalDuration: 30, wordsPerMinute: 150, charactersPerMinute: 750 }, emotion: 'neutral' as const },
    imagePrompt: makePrompt('Image prompt content'),
    videoPrompt: makePrompt('Video prompt content'),
    cameraDirection: { type: 'static' as const, movement: 'none', angle: 'eye-level', lens: '50mm' },
    emotionalIntensity: 5,
    transitionType: 'cut' as const,
    characterState: { characterId: 'ch-1', position: 'center', action: 'standing', emotion: 'neutral', expression: 'neutral', bodyLanguage: 'relaxed' },
    environmentState: { environmentId: 'en-1', timeOfDay: 'day', weather: 'clear', lighting: 'bright', atmosphere: 'peaceful', ambientSounds: ['birds'] },
  };
}

function createMockStory(overrides: any = {}) {
  return {
    id: 'story-123',
    title: 'My Test Story',
    genre: 'fantasy',
    status: 'complete',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T12:00:00.000Z',
    episodes: [
      {
        id: 'ep-1', number: 1, title: 'Episode One', synopsis: '', hook: '', cliffhanger: '', duration: 300,
        scenes: [makeScene('sc-1', 1)],
      },
      {
        id: 'ep-2', number: 2, title: 'Episode Two', synopsis: '', hook: '', cliffhanger: '', duration: 300,
        scenes: [makeScene('sc-2', 1)],
      },
    ],
    characters: [{ id: 'ch-1', name: 'Hero', description: '', appearance: '', personality: '', role: 'protagonist' as const }],
    environments: [{ id: 'en-1', name: 'Forest', description: '', type: '', timeOfDay: '', weather: '', mood: '', keyFeatures: [], colorPalette: [], lighting: { primary: '', ambient: '', colorTemperature: '', shadows: 'soft' as const } }],
    metadata: { totalEpisodes: 10, totalScenes: 2, estimatedDuration: 500, targetAudience: '', monetizationScore: 85, viralityScore: 85, retentionScore: 88, hookStrength: 90 },
    ...overrides,
  };
}

describe('StoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStory.mockReturnValue({ data: createMockStory(), isLoading: false, isError: false });
    mockUseDeleteStory.mockReturnValue({ mutate: mockDeleteMutate, isPending: false });
    mockUseRegenerateStory.mockReturnValue({ mutate: mockRegenMutate, isPending: false });
    mockUseRegenerateEpisode.mockReturnValue({ mutate: mockRegenEpMutate, isPending: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders story title', () => {
    render(<StoryPage />);
    expect(screen.getByText('My Test Story')).toBeInTheDocument();
  });

  it('shows spinner during loading', () => {
    mockUseStory.mockReturnValue({ data: null, isLoading: true, isError: false });
    render(<StoryPage />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
  });

  it('shows error state', () => {
    mockUseStory.mockReturnValue({ data: null, isLoading: false, isError: true });
    render(<StoryPage />);
    expect(screen.getByText('Failed to load story')).toBeInTheDocument();
  });

  it('displays episode titles', () => {
    render(<StoryPage />);
    expect(screen.getByText('Episode One')).toBeInTheDocument();
    expect(screen.getByText('Episode Two')).toBeInTheDocument();
  });

  it('switches tabs and shows the matching panel content', async () => {
    const user = userEvent.setup();
    render(<StoryPage />);

    // Overview tab: EpisodeCard is rendered (mocked) once per episode.
    expect(screen.getAllByTestId('episode-card')).toHaveLength(2);

    // Image Prompts tab: image prompt content from makeScene() is rendered.
    // The Overview tab also has the "Image Prompts" tab button visible, so we
    // click the first one and then look for the actual content rendered in the panel.
    const imageTabButton = screen.getAllByText(/Image Prompts/)[0]!;
    await user.click(imageTabButton);
    expect(await screen.findAllByText('Image prompt content')).toHaveLength(2);

    // Video Prompts tab: video prompt content from makeScene() is rendered.
    const videoTabButton = screen.getAllByText(/Video Prompts/)[0]!;
    await user.click(videoTabButton);
    expect(await screen.findAllByText('Video prompt content')).toHaveLength(2);
  });

  it('opens delete confirmation modal', async () => {
    const user = userEvent.setup();
    render(<StoryPage />);

    await user.click(screen.getByRole('button', { name: /Delete story/i }));
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();
  });

  it('calls delete mutation on confirm', async () => {
    const user = userEvent.setup();
    mockUseDeleteStory.mockReturnValue({ mutate: mockDeleteMutate, isPending: false });
    render(<StoryPage />);

    await user.click(screen.getByRole('button', { name: /Delete story/i }));
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));

    expect(mockDeleteMutate).toHaveBeenCalledWith('story-123', expect.any(Object));
  });

  it('shows export button', () => {
    render(<StoryPage />);
    expect(screen.getByRole('button', { name: /Export/ })).toBeInTheDocument();
  });

  it('M57: clicking inside the modal content does not close it (propagation bug guard)', async () => {
    const user = userEvent.setup();
    render(<StoryPage />);

    await user.click(screen.getByRole('button', { name: /Delete story/i }));
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();

    // Click the modal content wrapper, not the backdrop or the X button.
    // The previous mock closed on any click inside the modal, hiding real
    // event-propagation bugs.
    await user.click(screen.getByTestId('modal'));
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();
  });
});
