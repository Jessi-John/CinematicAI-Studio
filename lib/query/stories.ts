import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch, type ApiResponse } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';
import type { Story } from '@/types';


// Helper to extract data from ApiResponse.
// H8: Previously returned null on !response.success, which meant TanStack Query
// never saw an error — isError stayed false, error UIs were unreachable (the
// story detail page showed an infinite spinner on 404/401/500). Now throws so
// TanStack Query populates isError and the error state UIs render.
function getData<T>(response: ApiResponse<T>): T {
  if (response.success && 'data' in response) {
    return response.data as T;
  }
  const errorMsg = 'error' in response && response.error ? response.error : 'Request failed';
  throw new Error(errorMsg);
}

export interface StoriesListPage {
  stories: Story[];
  // PERF-LIST-TOTAL: the backend skips the COUNT query on cursor pages
  // (page 2+) and returns null there. Only the first page carries a number.
  total: number | null;
  hasMore: boolean;
  nextCursor?: string;
}

// PAG-1: Cursor-based infinite scroll for the dashboard/history lists.
// Previously useStories() fetched every story at once; for users with
// 100+ stories that pulled the full episode/scene hierarchy and caused
// jank/timeouts. We now request 20 stories at a time and load more on demand.
export function useInfiniteStories(search?: string, genre?: string | null, sortBy?: string | null) {
  const query = useInfiniteQuery<StoriesListPage, Error>({
    queryKey: ['stories', 'infinite', search ?? '', genre ?? '', sortBy ?? 'newest'],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set('limit', '20');
      if (search) params.set('search', search);
      if (genre) params.set('genre', genre);
      if (sortBy) params.set('sortBy', sortBy);
      const cursor = pageParam as string | undefined;
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const response = await apiFetch<StoriesListPage>(
        `${API_BASE}/api/stories${qs ? `?${qs}` : ''}`,
        { signal }
      );
      const data = getData(response);
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 1000 * 30,
    refetchOnWindowFocus: true,
  });

  const stories = useMemo(
    () => query.data?.pages.flatMap((page) => page.stories) ?? [],
    [query.data]
  );
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    stories,
    total,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

// Fetch only 3 most recent stories for sidebar. Dedicated endpoint avoids
// loading 100+ full story objects when only 3 titles are needed.
// Fix: Previously the sidebar used useStories() which fetched ALL stories
// just to display the 3 most recent. For a user with 100+ stories, this
// was ~40x more data than needed.
export function useRecentStories() {
  return useQuery({
    queryKey: ['stories', 'recent'],
    queryFn: async ({ signal }) => {
      const response = await apiFetch<{ stories: Story[]; total: number }>(
        `${API_BASE}/api/stories?limit=3`,
        { signal }
      );
      const data = getData(response);
      return data.stories || [];
    },
    staleTime: 1000 * 60 * 2,
  });
}

// Fetch single story. `initialData` is used for SSR hydration so the query
// is always active and invalidations from mutations refresh the UI.
export function useStory(id: string | null, initialData?: Story) {
  return useQuery({
    queryKey: ['story', id],
    queryFn: async ({ signal }) => {
      if (!id) return null;
      const response = await apiFetch<Story>(
        `${API_BASE}/api/stories/${id}`,
        { signal }
      );
      return getData(response);
    },
    enabled: !!id,
    initialData,
    staleTime: 1000 * 60 * 5,
  });
}

// Fetch only the total count for badge displays (P3). Much lighter than
// useStories() which fetches the full story list with all episodes/scenes.
// Uses limit=1 so only 1 story row is returned, but the `total` field from
// the API gives the full count for the badge.
export function useStoryCount() {
  return useQuery({
    queryKey: ['stories', 'count'],
    queryFn: async ({ signal }) => {
      const response = await apiFetch<{ stories: Story[]; total: number | null }>(
        `${API_BASE}/api/stories?limit=1`,
        { signal }
      );
      const data = getData(response);
      return data.total ?? 0;
    },
    staleTime: 1000 * 60 * 2,
  });
}

// Delete story mutation
export function useDeleteStory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (storyId: string) => {
      const data = await apiFetch<{ success: boolean }>(
        `${API_BASE}/api/stories/${storyId}`,
        { method: 'DELETE', isMutation: true }
      );
      // H9: Previously returned apiFetch(...) directly without checking
      // data.success. A 403/404/500 JSON response ({success:false, error})
      // resolved without throwing, so useMutation treated it as success —
      // firing onSuccess (cache invalidated, "Story deleted" toast) even
      // though the story still existed on the server.
      if (!data.success) throw new Error(data.error ?? 'Failed to delete story');
      return data;
    },
    onSuccess: (_data, storyId) => {
      queryClient.invalidateQueries({ queryKey: ['stories', 'infinite'] });
      queryClient.invalidateQueries({ queryKey: ['stories', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['stories', 'count'] });
      queryClient.removeQueries({ queryKey: ['story', storyId] });
    },
  });
}

// Regenerate an entire story atomically (replace-in-place)
export function useRegenerateStory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (storyId: string) => {
      const response = await apiFetch<{ storyId: string; replacedStoryId: string }>(
        `${API_BASE}/api/stories/generate/${storyId}/regenerate`,
        // H26: full-story regeneration takes ~7+ min at 10 episodes; the
        // server wall-clock scales with episode count (see
        // backend story-regeneration.ts getRegenerationTimeoutMs).
        { method: 'POST', timeout: 15 * 60_000, isMutation: true }
      );
      return getData(response);
    },
    onSuccess: (_data, oldStoryId) => {
      queryClient.invalidateQueries({ queryKey: ['stories', 'infinite'] });
      queryClient.invalidateQueries({ queryKey: ['stories', 'recent'] });
      queryClient.invalidateQueries({ queryKey: ['stories', 'count'] });
      queryClient.invalidateQueries({ queryKey: ['story', oldStoryId] });
    },
  });
}