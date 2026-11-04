import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockAddToast, mockReplace, mockPush, mockRegenScene } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockReplace: vi.fn(),
  mockPush: vi.fn(),
  mockRegenScene: { mutate: vi.fn(), isPending: false, variables: null as unknown },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'story-1', episodeId: 'ep-1' }),
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
vi.mock('@/lib/stores/app-store', () => ({
  // The component uses a selector (useAppStore((s) => s.addToast)) — apply it.
  useAppStore: (selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: () => {
        const Component = ({ children, ...props }: any) => <div {...props}>{children}</div>;
        Component.displayName = 'motion';
        return Component;
      },
    }
  ),
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

import EpisodePage from './page';

const sceneOne = {
  id: 'scene-1',
  number: 1,
  narration: { text: 'First scene narration text.', emotion: 'hopeful' },
  imagePrompt: { content: 'image prompt one' },
  videoPrompt: { content: 'video prompt one' },
  emotionalIntensity: 4,
  transitionType: 'cut',
  duration: 8,
  cameraDirection: { type: 'pan' },
  characterState: { action: 'walking' },
  environmentState: { atmosphere: 'calm' },
};

const sceneTwo = {
  ...sceneOne,
  id: 'scene-2',
  number: 2,
  narration: { text: 'Second scene narration text.', emotion: 'tense' },
  imagePrompt: { content: 'image prompt two' },
  videoPrompt: { content: 'video prompt two' },
};

const story = {
  id: 'story-1',
  title: 'The Cold Door',
  genre: 'fantasy',
  status: 'complete',
  episodes: [
    {
      id: 'ep-1',
      number: 1,
      title: 'The Door',
      duration: 55,
      synopsis: 'A door appears.',
      hook: 'A knock at midnight.',
      cliffhanger: 'The door opens by itself.',
      scenes: [sceneOne, sceneTwo],
    },
  ],
} as any;

vi.mock('@/lib/query/stories', () => ({
  useStory: vi.fn(),
}));
import { useStory } from '@/lib/query/stories';
const mockUseStory = vi.mocked(useStory);

vi.mock('@/lib/query/analytics', () => ({
  useRegenerateScene: vi.fn(),
  useRegenerateEpisode: vi.fn(),
}));
import { useRegenerateScene } from '@/lib/query/analytics';
const mockUseRegenerateScene = vi.mocked(useRegenerateScene);

describe('EpisodePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStory.mockReturnValue({ data: story, isLoading: false } as any);
    mockUseRegenerateScene.mockReturnValue(mockRegenScene as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the episode header, beat cards, and every scene row', () => {
    render(<EpisodePage />);

    expect(screen.getByRole('heading', { name: 'The Door' }).textContent).toBe('The Door');
    // "{scenes.length} scenes - ~{duration}s" renders as multiple text nodes.
    expect(screen.getByText(/2 scenes/).textContent).toMatch(/2 scenes/);
    expect(screen.getByText('A knock at midnight.').textContent).toBe('A knock at midnight.');
    expect(screen.getByText('The door opens by itself.').textContent).toBe('The door opens by itself.');
    // Narration renders twice per scene (preview line + narration block).
    expect(screen.getAllByText('First scene narration text.').length).toBe(2);
    expect(screen.getAllByText('Second scene narration text.').length).toBe(2);
    expect(screen.getByText('image prompt one').textContent).toBe('image prompt one');
    expect(screen.getByText('video prompt two').textContent).toBe('video prompt two');
  });

  it('shows the loading spinner while the story query is in flight', () => {
    mockUseStory.mockReturnValue({ data: undefined, isLoading: true } as any);
    const { container } = render(<EpisodePage />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'The Door' })).toBeNull();
  });

  it('redirects to the story page when the episode id does not exist', async () => {
    mockUseStory.mockReturnValue({
      data: { ...story, episodes: [] },
      isLoading: false,
    } as any);
    render(<EpisodePage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/story/story-1');
    });
  });

  it('copies all prompts to the clipboard via Copy All Prompts', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<EpisodePage />);
    await user.click(screen.getByRole('button', { name: 'Copy all prompts' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain('Scene 1:');
    expect(copied).toContain('image prompt one');
    expect(copied).toContain('video prompt one');
    expect(copied).toContain('First scene narration text.');
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Copied to clipboard');
  });

  it('routes scene regeneration through the mutation with episode/scene numbers and reports success', async () => {
    const user = userEvent.setup();
    mockRegenScene.mutate.mockImplementation(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      }
    );

    render(<EpisodePage />);
    await user.click(screen.getByRole('button', { name: 'Regenerate scene 1' }));

    expect(mockRegenScene.mutate).toHaveBeenCalledTimes(1);
    const vars = mockRegenScene.mutate.mock.calls[0]![0] as {
      episodeNumber: number;
      sceneNumber: number;
    };
    expect(vars).toEqual({ episodeNumber: 1, sceneNumber: 1 });
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Scene 1.1 regenerated');
  });

  it('surfaces a regeneration failure as an error toast', async () => {
    const user = userEvent.setup();
    mockRegenScene.mutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.(new Error('Scene regeneration failed'));
      }
    );

    render(<EpisodePage />);
    await user.click(screen.getByRole('button', { name: 'Regenerate scene 2' }));

    expect(mockRegenScene.mutate).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Scene regeneration failed');
  });

  it('exports the episode narration as a downloadable text file', async () => {
    const user = userEvent.setup();
    const clickSpy = vi.fn();
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = clickSpy;
    const originalCreateObjectURL = (URL as unknown as Record<string, unknown>).createObjectURL;
    const originalRevokeObjectURL = (URL as unknown as Record<string, unknown>).revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    try {
      render(<EpisodePage />);
      // Quick Export row: the narration download button.
      await user.click(screen.getByRole('button', { name: 'Narration' }));

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blobArg = createObjectURL.mock.calls[0]![0] as Blob;
      expect(blobArg).toBeInstanceOf(Blob);
      expect(mockAddToast).toHaveBeenCalledWith('success', 'Episode exported');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      Object.defineProperty(URL, 'createObjectURL', {
        value: originalCreateObjectURL,
        configurable: true,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: originalRevokeObjectURL,
        configurable: true,
      });
    }
  });
});
