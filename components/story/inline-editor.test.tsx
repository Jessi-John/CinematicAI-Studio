import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockAddToast, mockApiFetch } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/utils/api', () => ({ apiFetch: mockApiFetch }));
vi.mock('@/lib/config', () => ({ API_BASE: 'http://localhost:34567' }));
vi.mock('@/lib/stores/app-store', () => ({
  // The component uses a selector (useAppStore((s) => s.addToast)) — apply it.
  useAppStore: (selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

import { InlineEditor } from './inline-editor';

describe('InlineEditor', () => {
  const baseProps = {
    storyId: 'story-1',
    episodeNumber: 1,
    field: 'narrationText' as const,
    value: 'Scene narration',
    version: 0,
    label: 'Narration',
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives each rendered instance a unique DOM id for the same field', () => {
    render(
      <>
        <InlineEditor {...baseProps} sceneNumber={1} />
        <InlineEditor {...baseProps} sceneNumber={2} />
      </>
    );

    const displays = screen.getAllByText('Scene narration');
    expect(displays.length).toBeGreaterThanOrEqual(2);
    const display1 = displays[0]!;
    const display2 = displays[1]!;

    expect(display1.id).not.toBe('');
    expect(display2.id).not.toBe('');
    expect(display1.id).not.toBe(display2.id);
    // Both contain the field name, but the id is scoped by scene number.
    expect(display1.id).toContain('narrationText');
    expect(display1.id).toContain('1');
    expect(display2.id).toContain('2');
  });

  it('scopes the id by episodeNumber when no sceneNumber is provided', () => {
    render(
      <>
        <InlineEditor {...baseProps} episodeNumber={1} />
        <InlineEditor {...baseProps} episodeNumber={2} />
      </>
    );

    const displays = screen.getAllByText('Scene narration');
    expect(displays.length).toBe(2);
    expect(displays[0]!.id).not.toBe(displays[1]!.id);
  });

  it('sends the optimistic-lock payload (narrationText + expectedVersion) and closes on success', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ success: true });
    render(<InlineEditor {...baseProps} sceneNumber={1} version={3} />);

    await user.click(screen.getByRole('button', { name: 'Edit Narration' }));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Updated narration text');
    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      'http://localhost:34567/api/stories/story-1/episodes/1/scenes/1',
      {
        method: 'PATCH',
        isMutation: true,
        body: JSON.stringify({ narrationText: 'Updated narration text', expectedVersion: 3 }),
      }
    );
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Narration saved');
    // Editor closed: the textbox is gone, the display paragraph is back.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('surfaces the version-conflict error and keeps the editor open on 409', async () => {
    const user = userEvent.setup();
    // Matches the backend's OPTIMISTIC_LOCK_CONFLICT AppError message
    // (backend/src/database/prisma-storage/write.ts updateSceneNarration).
    mockApiFetch.mockResolvedValueOnce({
      success: false,
      error: 'Conflict — the scene was modified by another request. Please refresh and try again.',
    });
    render(<InlineEditor {...baseProps} sceneNumber={1} version={2} />);

    await user.click(screen.getByRole('button', { name: 'Edit Narration' }));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Concurrent edit attempt');
    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        'error',
        'Conflict — the scene was modified by another request. Please refresh and try again.'
      );
    });
    // Editor stays open so the user can copy their text, refresh, and retry.
    const stillOpen = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(stillOpen.value).toBe('Concurrent edit attempt');
    expect(baseProps.onSave).not.toHaveBeenCalled();
  });

  it('rejects narration under 10 characters without calling the API', async () => {
    const user = userEvent.setup();
    render(<InlineEditor {...baseProps} sceneNumber={1} version={1} />);

    await user.click(screen.getByRole('button', { name: 'Edit Narration' }));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'short');
    await user.click(screen.getByRole('button', { name: /Save/i }));

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Narration must be at least 10 characters');
  });
});
