'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';

export function useRegenerateEpisode(storyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (episodeNumber: number) => {
      const r = await apiFetch<{ regenerated: boolean }>(
        `${API_BASE}/api/stories/generate/${storyId}/episodes/${episodeNumber}`,
        { method: 'PATCH', isMutation: true }
      );
      if (!r.success) {
        throw new Error((r as { error?: string }).error ?? 'Episode regeneration failed');
      }
      return r.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story', storyId] });
    },
  });
}

export function useRegenerateScene(storyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { episodeNumber: number; sceneNumber: number }) => {
      const r = await apiFetch<{ regenerated: boolean }>(
        `${API_BASE}/api/stories/generate/${storyId}/episodes/${vars.episodeNumber}/scenes/${vars.sceneNumber}`,
        { method: 'PATCH', isMutation: true }
      );
      if (!r.success) {
        throw new Error((r as { error?: string }).error ?? 'Scene regeneration failed');
      }
      return r.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story', storyId] });
    },
  });
}
