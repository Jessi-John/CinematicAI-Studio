/**
 * Tests for AppStore: toggleSidebar, setSearchQuery, setFilterGenre,
 * addToast, removeToast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAppStore } from './app-store';

describe('useAppStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAppStore.setState({
      sidebarCollapsed: false,
      searchQuery: '',
      filterGenre: null,
      toasts: [],
    });
  });

  describe('toggleSidebar', () => {
    it('should toggle sidebarCollapsed from false to true', () => {
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    });

    it('should toggle sidebarCollapsed from true to false', () => {
      useAppStore.setState({ sidebarCollapsed: true });
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe('setSearchQuery', () => {
    it('should update searchQuery', () => {
      useAppStore.getState().setSearchQuery('my search');
      expect(useAppStore.getState().searchQuery).toBe('my search');
    });
  });

  describe('setFilterGenre', () => {
    it('should set filterGenre to a string', () => {
      useAppStore.getState().setFilterGenre('fantasy');
      expect(useAppStore.getState().filterGenre).toBe('fantasy');
    });

    it('should set filterGenre to null', () => {
      useAppStore.setState({ filterGenre: 'fantasy' });
      useAppStore.getState().setFilterGenre(null);
      expect(useAppStore.getState().filterGenre).toBeNull();
    });
  });

  describe('addToast', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should add a toast to the list', () => {
      useAppStore.getState().addToast('success', 'Operation complete');
      const toasts = useAppStore.getState().toasts;
      expect(toasts.length).toBe(1);
      expect(toasts[0]!.type).toBe('success');
      expect(toasts[0]!.message).toBe('Operation complete');
    });

    it('should deduplicate identical messages within the debounce window', () => {
      useAppStore.getState().addToast('info', 'Same message');
      const originalToast = useAppStore.getState().toasts[0]!;
      const originalId = originalToast.id;
      expect(useAppStore.getState().toasts.length).toBe(1);
      useAppStore.getState().addToast('info', 'Same message');
      // The second addToast is suppressed: the existing toast is kept
      // unchanged (no id rotation). This prevents a noisy stream of
      // identical messages from spamming the UI. Pin the contract by
      // asserting the id is unchanged.
      const toastAfter = useAppStore.getState().toasts[0]!;
      expect(toastAfter.id).toBe(originalId);
      expect(useAppStore.getState().toasts.length).toBe(1);
    });

    it('should not deduplicate different messages', () => {
      useAppStore.getState().addToast('success', 'Message A');
      useAppStore.getState().addToast('error', 'Message B');
      expect(useAppStore.getState().toasts.length).toBe(2);
    });
  });

  describe('removeToast', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should remove a toast by id', () => {
      useAppStore.getState().addToast('success', 'Test toast');
      const id = useAppStore.getState().toasts[0]!.id;
      useAppStore.getState().removeToast(id);
      expect(useAppStore.getState().toasts.length).toBe(0);
    });

    it('should be safe to call with non-existent id', () => {
      useAppStore.getState().addToast('success', 'Test toast');
      useAppStore.getState().removeToast('non-existent-id');
      expect(useAppStore.getState().toasts.length).toBe(1);
    });
  });
});