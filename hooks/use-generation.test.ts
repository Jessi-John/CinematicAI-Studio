import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Shared mocks — these are controlled by each test to simulate different scenarios.
const mockApiFetch = vi.fn();
const mockCancel = vi.fn();

// Wire BOTH apiFetch and apiFetchWithCancel through mockApiFetch so a single
// mock controls the initial POST (generate) AND subsequent story fetches.
// Fix: previously apiFetchWithCancel was hardcoded to return success, making
// error and cancel tests impossible to pass.
vi.mock('@/lib/utils/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  apiFetchWithCancel: (...args: unknown[]) => ({
    promise: mockApiFetch(...args),
    cancel: mockCancel,
  }),
}));

// Mock API_BASE to a deterministic URL so tests never depend on env vars or window.
vi.mock('@/lib/config', () => ({
  API_BASE: 'http://localhost:34567',
  PROXY_TARGET: 'http://localhost:34567',
}));

// Mock EventSource with static instance tracking.
// Fix: vi.stubGlobal does NOT instrument the class with vitest's mock
// tracking (no .mock property), so vi.mocked(EventSource).mock?.instances
// would always be undefined. We add static instance tracking so tests
// can access the latest EventSource instance directly.
class MockEventSource {
  static instances: MockEventSource[] = [];
  static reset() {
    MockEventSource.instances = [];
  }
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate connection open on next tick
    setTimeout(() => {
      this.onopen?.();
    }, 0);
  }
}

vi.stubGlobal('EventSource', MockEventSource);

/** Get the most recent EventSource instance created by the hook */
function getLatestEventSource(): MockEventSource | undefined {
  const instances = MockEventSource.instances;
  return instances.length > 0 ? instances[instances.length - 1] : undefined;
}

import { useGeneration } from './use-generation';

describe('useGeneration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.reset();
    mockApiFetch.mockReset();
    mockCancel.mockReset();
    // Default mock: generate POST succeeds, story fetch succeeds
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/stories/generate')) {
        return Promise.resolve({
          success: true,
          data: {
            jobId: 'job-123',
            requestId: 'req-123',
            sseUrl: 'http://localhost:34567/api/stories/generate/job-123/events?auth=ab' + 'a'.repeat(62) + '&t=1234567890',
            sseAuth: { auth: 'ab' + 'a'.repeat(62), t: 1234567890 },
          },
        });
      }
      if (url.includes('/api/stories/')) {
        return Promise.resolve({
          success: true,
          data: {
            id: 'story-1',
            title: 'Generated Story',
            genre: 'fantasy',
            status: 'complete',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            episodes: [],
            characters: [],
            environments: [],
            metadata: {
              totalEpisodes: 10,
              totalScenes: 50,
              estimatedDuration: 500,
              targetAudience: '',
              monetizationScore: 85,
              viralityScore: 85,
              retentionScore: 88,
              hookStrength: 90,
            },
          },
        });
      }
      return Promise.resolve({ success: true, data: null });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should start in idle state', () => {
    const { result } = renderHook(() => useGeneration());

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.generatedStory).toBeNull();
    expect(result.current.jobId).toBeNull();
  });

  it('should set isGenerating true when generate is called with valid options', async () => {
    const { result } = renderHook(() => useGeneration());

    await act(async () => {
      result.current.generate({ genre: ['fantasy'], seed: 'test story' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isGenerating).toBe(true);
  });

  it('should call onStart callback when generation begins', async () => {
    const onStart = vi.fn();
    const { result } = renderHook(() => useGeneration({ onStart }));

    await act(async () => {
      result.current.generate({ genre: ['fantasy'], seed: 'test story' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onStart).toHaveBeenCalled();
  });

  it('should set error when API returns failure', async () => {
    const onError = vi.fn();

    // Make the generate POST fail — since apiFetchWithCancel is wired through
    // mockApiFetch, this rejects the initial POST and the hook sets the error.
    mockApiFetch.mockRejectedValue(new Error('API unavailable'));

    const { result } = renderHook(() => useGeneration({ onError }));

    await act(async () => {
      await result.current.generate({ genre: ['fantasy'] }).catch(() => {});
    });

    // The hook stores error as a string (the error message), not an Error
    // instance — the contract is "human-readable message". Verify the
    // message contains the source error and that isGenerating resets.
    expect(typeof result.current.error).toBe('string');
    expect(result.current.error).toContain('API unavailable');
    expect(result.current.isGenerating).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('should reset to initial state when reset is called', async () => {
    const { result } = renderHook(() => useGeneration());

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
    });

    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.generatedStory).toBeNull();
    expect(result.current.jobId).toBeNull();
  });

  it('should close EventSource on reset', async () => {
    const { result } = renderHook(() => useGeneration());

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
      await vi.advanceTimersByTimeAsync(0);
    });

    const es = getLatestEventSource();
    expect(es).not.toBeNull();

    await act(async () => {
      result.current.reset();
    });

    // reset() calls eventSourceRef.current?.close()
    expect(es!.close).toHaveBeenCalled();
  });

  it('should close EventSource on component unmount', async () => {
    const { result, unmount } = renderHook(() => useGeneration());

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
      await vi.advanceTimersByTimeAsync(0);
    });

    const es = getLatestEventSource();
    expect(es).not.toBeNull();

    unmount();

    // The cleanup effect calls eventSourceRef.current?.close()
    expect(es!.close).toHaveBeenCalled();
  });

  it('should set progress on SSE progress event', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() => useGeneration({ onProgress }));

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
    });

    // Simulate SSE progress event
    await act(async () => {
      const es = getLatestEventSource();
      es?.onmessage?.({ data: JSON.stringify({
        type: 'progress',
        stage: 'blueprint',
        progress: 25,
        message: 'Creating blueprint...',
      }) });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.progress).not.toBeNull();
    expect(result.current.progress?.stage).toBe('blueprint');
    expect(result.current.progress?.progress).toBe(25);
  });

  it('should handle SSE completion event and fetch the story', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useGeneration({ onSuccess }));

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
    });

    // Fire SSE completion and flush microtasks inside a single act block
    // so React properly tracks all state updates including those from
    // the await apiFetch(...) microtask continuation.
    await act(async () => {
      const es = getLatestEventSource();
      es?.onmessage?.({ data: JSON.stringify({
        type: 'complete',
        data: { storyId: 'story-1' },
      }) });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onSuccess).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'story-1' }));
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress?.stage).toBe('complete');
    expect(result.current.progress?.progress).toBe(100);
    expect(result.current.generatedStory).not.toBeNull();
    expect(result.current.generatedStory?.id).toBe('story-1');
  });

  it('should handle SSE error event', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGeneration({ onError }));

    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
    });

    await act(async () => {
      const es = getLatestEventSource();
      es?.onmessage?.({ data: JSON.stringify({
        type: 'error',
        message: 'Generation failed: token limit exceeded',
      }) });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.error).toBe('Generation failed: token limit exceeded');
    expect(onError).toHaveBeenCalledWith('Generation failed: token limit exceeded');
  });

  it('should ignore SSE heartbeat and connected events', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() => useGeneration({ onProgress }));

    // Create an EventSource by triggering a generation first
    await act(async () => {
      result.current.generate({ genre: ['fantasy'] });
    });

    await act(async () => {
      const es = getLatestEventSource();
      // connected and heartbeat events should not trigger onProgress
      es?.onmessage?.({ data: JSON.stringify({ type: 'connected' }) });
      es?.onmessage?.({ data: JSON.stringify({ type: 'heartbeat' }) });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onProgress).not.toHaveBeenCalled();
  });

  describe('H8: double-click in-flight guard (real hook)', () => {
    it('ignores a second generate() while one is in flight and still connects SSE for the first', async () => {
      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        // Two rapid clicks — the second must be a no-op AND must not invalidate
        // the first generation (previously the genId bump ran before the guard,
        // so the second click marked the first generation stale and it never
        // opened an SSE connection).
        const p1 = result.current.generate({ genre: ['fantasy'] });
        const p2 = result.current.generate({ genre: ['fantasy'] });
        await Promise.all([p1, p2]);
        await vi.advanceTimersByTimeAsync(0);
      });

      const generateCalls = mockApiFetch.mock.calls.filter((c) =>
        String(c[0]).includes('/api/stories/generate')
      );
      // Only one POST to /generate — the double-click was rejected by the guard.
      expect(generateCalls).toHaveLength(1);
      // The surviving (first) generation connected its SSE stream.
      expect(getLatestEventSource()).not.toBeNull();
      expect(getLatestEventSource()?.url).toContain('/api/stories/generate/job-123/events');
      expect(result.current.isGenerating).toBe(true);
      expect(result.current.jobId).toBe('job-123');
    });

    it('cancels the in-flight POST when reset() is called', async () => {
      // Hold the POST open so it is still in-flight when reset() runs.
      let resolvePost: (value: unknown) => void = () => {};
      mockApiFetch.mockImplementation((url: string) => {
        if (url.includes('/api/stories/generate')) {
          return new Promise((resolve) => {
            resolvePost = resolve;
          });
        }
        return Promise.resolve({ success: true, data: null });
      });

      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        void result.current.generate({ genre: ['fantasy'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        result.current.reset();
      });

      // Fix #39: reset() must abort the in-flight POST via its cancel handle.
      expect(mockCancel).toHaveBeenCalled();

      // Resolve the dangling POST so the test exits cleanly.
      await act(async () => {
        resolvePost({ success: false, error: 'aborted' });
        await vi.advanceTimersByTimeAsync(0);
      });
    });
  });

  describe('H8: buildSSEUrl HMAC auth', () => {
    it('appends the HMAC auth query params to the SSE URL when sseAuth is returned', async () => {
      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        result.current.generate({ genre: ['fantasy'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      const es = getLatestEventSource();
      expect(es).not.toBeNull();
      // The default mock returns sseAuth { auth: 'ab'+'a'.repeat(62), t: 1234567890 }.
      expect(es?.url).toContain('auth=ab');
      expect(es?.url).toContain('t=1234567890');
      expect(es?.url).toMatch(/\/api\/stories\/generate\/job-123\/events\?auth=.+/);
    });

    it('omits auth params when the POST response has no sseAuth', async () => {
      mockApiFetch.mockImplementation((url: string) => {
        if (url.includes('/api/stories/generate')) {
          return Promise.resolve({
            success: true,
            data: { jobId: 'job-noauth', requestId: 'r', sseUrl: '' },
          });
        }
        return Promise.resolve({ success: true, data: null });
      });

      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        result.current.generate({ genre: ['fantasy'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      const es = getLatestEventSource();
      expect(es?.url).toBe('http://localhost:34567/api/stories/generate/job-noauth/events');
    });
  });

  describe('H8: SSE reconnect, backoff, and polling fallback', () => {
    it('reconnects with exponential backoff after an SSE error', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic jitter = 0
      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        result.current.generate({ genre: ['fantasy'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      const es1 = getLatestEventSource();
      const countBefore = MockEventSource.instances.length;

      await act(async () => {
        es1?.onerror?.();
        await vi.advanceTimersByTimeAsync(0); // flush the /status poll
      });

      // No reconnect yet — backoff (3000ms) has not elapsed.
      expect(MockEventSource.instances.length).toBe(countBefore);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000); // first backoff = 3000 * 2^0
      });

      // A new EventSource proves the reconnect fired after the backoff delay.
      expect(MockEventSource.instances.length).toBe(countBefore + 1);
      expect(getLatestEventSource()).not.toBe(es1);
    });

    it('falls back to polling after exhausting all reconnect attempts', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { result } = renderHook(() => useGeneration());

      await act(async () => {
        result.current.generate({ genre: ['fantasy'] });
        await vi.advanceTimersByTimeAsync(0);
      });

      // Exhaust the 5 reconnect attempts: fire onerror, then advance past the
      // (growing) backoff so the reconnect runs and errors again.
      for (let i = 0; i < 6; i++) {
        const es = getLatestEventSource();
        await act(async () => {
          es?.onerror?.();
          await vi.advanceTimersByTimeAsync(0); // flush /status poll
          await vi.advanceTimersByTimeAsync(35000); // > max backoff (30000)
        });
      }

      // After exhausting reconnects the hook switches to the polling fallback.
      expect(result.current.progress?.stage).toBe('polling');
      expect(result.current.isGenerating).toBe(true);
    });
  });
});
