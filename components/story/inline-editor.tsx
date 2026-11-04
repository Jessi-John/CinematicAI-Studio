'use client';

import { useState, useCallback } from 'react';
import { Edit3, Save, X, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/utils/api';
import { API_BASE } from '@/lib/config';
import { useAppStore } from '@/lib/stores/app-store';

interface InlineEditorProps {
  storyId: string;
  episodeNumber: number;
  sceneNumber?: number;
  field: 'narrationText' | 'hook' | 'synopsis' | 'cliffhanger' | 'title';
  value: string;
  version: number;
  label: string;
  onSave: (newValue: string) => void;
}

export function InlineEditor({
  storyId,
  episodeNumber,
  sceneNumber,
  field,
  value,
  version,
  label,
  onSave,
}: InlineEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const handleStartEdit = useCallback(() => {
    setEditValue(value);
    setIsEditing(true);
  }, [value]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue(value);
  }, [value]);

  const handleSave = useCallback(async () => {
    const trimmed = editValue.trim();
    if (trimmed === value.trim()) {
      setIsEditing(false);
      return;
    }

    if (field === 'title' && trimmed.length === 0) {
      addToast('error', 'Title cannot be empty');
      return;
    }
    if (field === 'narrationText' && trimmed.length < 10) {
      addToast('error', 'Narration must be at least 10 characters');
      return;
    }

    setIsSaving(true);
    try {
      if (sceneNumber !== undefined) {
        // Scene narration edit
        const res = await apiFetch(
          `${API_BASE}/api/stories/${storyId}/episodes/${episodeNumber}/scenes/${sceneNumber}`,
          {
            method: 'PATCH',
            isMutation: true,
            body: JSON.stringify({ narrationText: trimmed, expectedVersion: version }),
          }
        );
        if (!res.success) {
          throw new Error((res as { error?: string }).error || 'Failed to save');
        }
      } else {
        // Episode meta edit
        const res = await apiFetch(
          `${API_BASE}/api/stories/${storyId}/episodes/${episodeNumber}`,
          {
            method: 'PATCH',
            isMutation: true,
            body: JSON.stringify({ [field]: trimmed, expectedVersion: version }),
          }
        );
        if (!res.success) {
          throw new Error((res as { error?: string }).error || 'Failed to save');
        }
      }
      onSave(trimmed);
      setIsEditing(false);
      addToast('success', `${label} saved`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      addToast('error', msg);
    } finally {
      setIsSaving(false);
    }
  }, [editValue, value, storyId, episodeNumber, sceneNumber, field, label, onSave, addToast, version]);

  // Unique per story/episode/scene/field so multiple editors of the same field
  // (e.g. narrationText across scenes) never collide on a shared DOM id.
  const inputId = `${field}-input-${storyId}-${episodeNumber}${sceneNumber !== undefined ? `-${sceneNumber}` : ''}`;

  if (!isEditing) {
    return (
      <div className="group relative">
        <p id={`${inputId}-display`} className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
          {value}
        </p>
        <button
          type="button"
          onClick={handleStartEdit}
          className="absolute top-0 right-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none bg-[var(--bg-tertiary)] border border-[var(--border)] hover:border-purple-500 transition-all"
          title={`Edit ${label}`}
          aria-label={`Edit ${label}`}
        >
          <Edit3 className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const isMultiline = ['narrationText', 'synopsis'].includes(field);

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="sr-only">{label}</label>
      {isMultiline ? (
        <textarea
          id={inputId}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="w-full min-h-[80px] bg-[var(--bg-tertiary)] border border-purple-500/50 rounded-lg p-3 text-sm text-white font-mono resize-y focus:outline-none focus:border-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500/30"
          disabled={isSaving}
          maxLength={2000}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="w-full bg-[var(--bg-tertiary)] border border-purple-500/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500 focus-visible:ring-2 focus-visible:ring-purple-500/30"
          disabled={isSaving}
          maxLength={500}
        />
      )}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={handleCancel}
          disabled={isSaving}
          className="p-1.5 rounded-md hover:bg-white/10 text-[var(--text-tertiary)] transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
          aria-label="Cancel"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || editValue === value}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/20 text-purple-400 rounded-lg text-sm font-medium hover:bg-purple-500/30 transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
        >
          {isSaving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          Save
        </button>
      </div>
    </div>
  );
}
