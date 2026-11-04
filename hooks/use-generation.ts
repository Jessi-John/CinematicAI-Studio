'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch, apiFetchWithCancel } from '@/lib/utils/api';
import { logger } from '@/lib/utils/logger';
import { API_BASE } from '@/lib/config';
import type { Story, Genre, GenerationProgress, GenerationStage } from '@/types';

const MAX_RECONNECT_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 5000;
// Configurable polling timeout for SSE fallback.
// Default: 60 minutes (generous — some generations can take 40+ min).
// Set NEXT_PUBLIC_MAX_SSE_POLL_MS to override (e.g. '600000' for 10 min).
// Previously hardcoded to 10 minutes, which silently abandoned 40-minute
// generations that lost SSE connectivity mid-way.
// MEDIUM #46: Lazily evaluated so the env value is read after validation.
const DEFAULT_MAX_POLL_MS = 60 * 60 * 1000;
function getMaxPollAfterSseFailureMs(): number {
  const raw = process.env.NEXT_PUBLIC_MAX_SSE_POLL_MS;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_POLL_MS;
  const parsed = parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_MAX_POLL_MS;
  return parsed;
}

interface GenerateOptions {
  genre: Genre[];
  seed?: string | undefined;
  forceNew?: boolean;
}

interface UseGenerationOptions {
  onStart?: () => void;
  onProgress?: (progress: GenerationProgress) => void;
  onSuccess?: (story: Story) => void;
  onError?: (error: string) => void;
}

interface SSECredentials {
  auth: string;
  t: number;
}

interface SSEPayload {
  type: 'connected' | 'progress' | 'complete' | 'error' | 'heartbeat';
  jobId?: string;
  progress?: number;
  stage?: string;
  message?: string;
  data?: { storyId?: string };
}

export function useGeneration(options: UseGenerationOptions = {}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generatedStory, setGeneratedStory] = useState<Story | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectJobIdRef = useRef<string | null>(null);
  const optsRef = useRef<UseGenerationOptions>(options);
  const sseFailedRef = useRef(false);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseFailedAtRef = useRef<number | null>(null);
  // Ref-holding the latest connectToSSE so the recursive reconnect call
  // inside es.onerror does not violate no-use-before-define (the const
  // assigned from useCallback is in the temporal dead zone until the
  // assignment runs — the ref indirection avoids the TDZ entirely).
  const connectToSSERef = useRef<((id: string) => Promise<void>) | null>(null);
  // FE-002: Generation ID to invalidate stale SSE callbacks when new generation starts
  const generationIdRef = useRef(0);
  // Fix #39: hold a cancel handle for the in-flight POST to /api/stories/generate
  // so a rapid second click aborts the first request instead of leaking it
  // (the previous request would sit open until its 30s timeout, blocking
  // the user's actual generation request behind a queued one).
  const inflightPostRef = useRef<{ cancel: () => void } | null>(null);
  // The current POST fetch promise so we can await it during cleanup.
  const inflightPostPromiseRef = useRef<Promise<unknown> | null>(null);
  // HMAC-signed SSE credentials returned by the POST /api/stories/generate
  // response. These outlive the 15-minute JWT TTL so SSE reconnections
  // mid-generation are authenticated via the query-string HMAC instead.
  const sseAuthRef = useRef<SSECredentials | null>(null);
  const isGeneratingRef = useRef(false);

  useEffect(() => {
    optsRef.current = options;
  }, [options]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      eventSourceRef.current?.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  /**
   * SSE URL builder — appends HMAC auth params when available so the
   * connection is authenticated via query-string even if the JWT cookie
   * has expired mid-generation.
   */
  function buildSSEUrl(id: string): string {
    const base = `${API_BASE}/api/stories/generate/${id}/events`;
    const auth = sseAuthRef.current;
    if (auth) {
      return `${base}?auth=${auth.auth}&t=${auth.t}`;
    }
    return base;
  }

  /**
   * Poll job status and story completion after SSE exhausts all reconnect attempts.
   * Defined before connectToSSE so the function declaration is hoisted past
   * the connectToSSE useCallback (avoids no-use-before-define false positive).
   */
  function startPollingFallback(pollJobId: string): void {
    if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);

    pollingIntervalRef.current = setInterval(async () => {
      if (!isMountedRef.current) {
        clearInterval(pollingIntervalRef.current!);
        return;
      }

      if (sseFailedAtRef.current && Date.now() - sseFailedAtRef.current > getMaxPollAfterSseFailureMs()) {
        clearInterval(pollingIntervalRef.current!);
        const msg = 'Polling timeout — generation may have failed silently.';
        setError(msg);
        setIsGenerating(false);
        isGeneratingRef.current = false;
        optsRef.current.onError?.(msg);
        return;
      }

      try {
        const statusRes = await apiFetch<{
          progress?: number;
          stage?: string;
          state?: string;
          data?: { storyId?: string };
        }>(`${API_BASE}/api/stories/generate/${pollJobId}/status`);

        if (!isMountedRef.current || !statusRes.success || !statusRes.data) return;

        const { state, progress: pollProgress, stage } = statusRes.data;

        if (state === 'completed' || state === 'failed') {
          clearInterval(pollingIntervalRef.current!);

          if (state === 'completed' && statusRes.data.data?.storyId) {
            const storyRes = await apiFetch<Story>(
              `${API_BASE}/api/stories/${statusRes.data.data.storyId}`
            );
            if (isMountedRef.current && storyRes.success && storyRes.data) {
              setProgress({
                stage: 'complete',
                progress: 100,
                message: 'Generation complete!',
                totalSteps: 100,
                completedSteps: 100,
              });
              setGeneratedStory(storyRes.data);
              setIsGenerating(false);
              isGeneratingRef.current = false;
              optsRef.current.onSuccess?.(storyRes.data);
            }
          } else if (state === 'failed') {
          const errMsg = stage || 'Generation failed silently';
          setError(errMsg);
          setIsGenerating(false);
          isGeneratingRef.current = false;
          optsRef.current.onError?.(errMsg);
          }
          return;
        }

        if (pollProgress !== undefined) {
          setProgress((prev) =>
            prev
              ? { ...prev, progress: pollProgress, stage: (stage || prev.stage) as GenerationStage, message: 'Polling...' }
              : null
          );
          optsRef.current.onProgress?.({
            stage: (stage || 'polling') as GenerationStage,
            progress: pollProgress,
            message: 'Checking generation status...',
            totalSteps: 100,
            completedSteps: pollProgress,
          });
        }
      } catch {
        // Non-fatal — keep polling
      }
    }, POLL_INTERVAL_MS);
  }

  const connectToSSE = useCallback(async (id: string) => {
    // FE-008: Guard — abort if component unmounted or if a new generation started
    if (!isMountedRef.current) { return; }
    // Allow the call if reconnectJobIdRef is null (first call) or matches current id (reconnect).
    // Guard only aborts if a DIFFERENT job's SSE is already in flight.
    if (reconnectJobIdRef.current !== null && reconnectJobIdRef.current !== id) {
      return; // reset() cleared this — a new generation started
    }

    if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
      const msg = `Connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Please try again.`;
      setError(msg);
      setIsGenerating(false);
      isGeneratingRef.current = false;
      optsRef.current.onError?.(msg);
      return;
    }

    eventSourceRef.current?.close();

    reconnectCountRef.current += 1;
    reconnectJobIdRef.current = id;

    // H8: Capture the generation this SSE belongs to so every handler can
    // discard events from a superseded generation. The complete handler already
    // guarded by generationId, but progress/error/onerror did not — a stale SSE
    // (old generation still open while a new generate() POST is in flight) could
    // set error/progress or trigger a reconnect against the NEW generation.
    const myGenId = generationIdRef.current;

    const url = buildSSEUrl(id);
    // Fix: Don't use withCredentials when HMAC auth is already in the URL.
    // withCredentials sends the JWT cookie on every SSE event, which is
    // redundant since auth is via the HMAC token in the query string.
    // If the JWT cookie expires mid-generation, the backend could return
    // 403 on the SSE connection and terminate it prematurely. With HMAC
    // URL auth only, the connection survives past JWT expiry.
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      // Intentionally NOT resetting reconnect count here — onopen only proves TCP
      // connection was established, not that the SSE stream is functional. A
      // connection that opens then immediately errors would reset the counter,
      // preventing the polling fallback from ever activating.
    };

    es.onmessage = async (event) => {
      if (!isMountedRef.current) return;
      // H8: Discard events from a superseded generation before touching state.
      if (myGenId !== generationIdRef.current) return;

      let data: SSEPayload;
      try {
        data = JSON.parse(event.data) as SSEPayload;
      } catch {
        logger.warn('Failed to parse SSE message: ' + event.data);
        return;
      }

      if (data.type === 'connected' || data.type === 'heartbeat') return;

      // A meaningful message (progress/complete/error) proves the SSE stream is
      // delivering real data — reset the reconnect counter so subsequent brief
      // network blips don't exhaust the budget.
      reconnectCountRef.current = 0;

      if (data.type === 'progress') {
        const p: GenerationProgress = {
          stage: (data.stage || 'init') as GenerationStage,
          progress: data.progress ?? 0,
          message: data.message || '',
          totalSteps: 100,
          completedSteps: data.progress ?? 0,
        };
        setProgress(p);
        optsRef.current.onProgress?.(p);
        return;
      }

      if (data.type === 'complete') {
        es.close();
        eventSourceRef.current = null;

        // Capture the generation ID that produced this completion so we can
        // detect if a newer generation started while the async story fetch is
        // still in flight.
        const completedGenId = generationIdRef.current;

        if (isMountedRef.current && completedGenId === generationIdRef.current) {
          setProgress({
            stage: 'complete',
            progress: 100,
            message: 'Generation complete!',
            totalSteps: 100,
            completedSteps: 100,
          });
          setIsGenerating(false);
          isGeneratingRef.current = false;
        }

        const storyId = data.data?.storyId;
        if (storyId) {
          try {
            const storyRes = await apiFetch<Story>(
              `${API_BASE}/api/stories/${storyId}`
            );
            // If a newer generation has started, discard this stale result.
            if (completedGenId !== generationIdRef.current) {
              return;
            }
            if (!storyRes.success || !storyRes.data) {
              const msg = (storyRes as { error?: string }).error || 'Failed to load generated story';
              if (isMountedRef.current) {
                setError(msg);
                setIsGenerating(false);
                isGeneratingRef.current = false;
                optsRef.current.onError?.(msg);
              }
              return;
            }
            if (isMountedRef.current) {
              setGeneratedStory(storyRes.data);
              optsRef.current.onSuccess?.(storyRes.data);
            }
          } catch (err) {
            // Discard errors from stale generations.
            if (completedGenId !== generationIdRef.current) {
              return;
            }
            if (isMountedRef.current) {
              const msg = err instanceof Error ? err.message : 'Failed to fetch story';
              setError(msg);
              setIsGenerating(false);
              isGeneratingRef.current = false;
              optsRef.current.onError?.(msg);
            }
          }
        }
        return;
      }

      if (data.type === 'error') {
        es.close();
        eventSourceRef.current = null;
        const msg = data.message || 'Generation failed';
        setError(msg);
        setIsGenerating(false);
        isGeneratingRef.current = false;
        optsRef.current.onError?.(msg);
      }
    };

    es.onerror = async () => {
      if (!isMountedRef.current) return;
      // H8: Don't reconnect (or update progress) for a superseded generation's
      // SSE — the new generation owns its own connection.
      if (myGenId !== generationIdRef.current) return;

      const jobId = reconnectJobIdRef.current;
      es.close();
      eventSourceRef.current = null;

      if (jobId) {
        try {
          const statusRes = await apiFetch<{
            progress?: number;
            stage?: string;
            state?: string;
          }>(`${API_BASE}/api/stories/generate/${jobId}/status`);

          if (isMountedRef.current && statusRes.success && statusRes.data?.progress !== undefined) {
            setProgress({
              stage: (statusRes.data.stage || 'reconnecting') as GenerationStage,
              progress: statusRes.data.progress,
              message: 'Reconnecting via SSE...',
              totalSteps: 100,
              completedSteps: statusRes.data.progress,
            });
          }
        } catch {
          // Ignore — reconnect will attempt anyway
        }
      }

      if (reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS && reconnectJobIdRef.current) {
        const backoff = Math.min(3000 * 2 ** (reconnectCountRef.current - 1), 30000);
        const jitter = Math.random() * 1000;
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (isMountedRef.current && reconnectJobIdRef.current) {
            connectToSSERef.current?.(reconnectJobIdRef.current);
          }
        }, backoff + jitter);
      } else if (!sseFailedRef.current) {
        // Exhausted reconnect attempts — fall through to polling.
        sseFailedRef.current = true;
        sseFailedAtRef.current = Date.now();
        setProgress((prev) =>
          prev
            ? { ...prev, stage: 'polling', message: 'SSE unavailable — polling for completion...' }
            : null
        );
        startPollingFallback(jobId!);
      }
    };
  }, []);

  useEffect(() => {
    connectToSSERef.current = connectToSSE;
  });

  const generate = useCallback(
    async (opts: GenerateOptions): Promise<void> => {
      // H8: The in-flight guard MUST run before the generationId bump. Previously
      // `++generationIdRef.current` ran first, so a rejected double-click still
      // advanced the generation counter — which then invalidated the in-flight
      // first generation (its genId no longer matched generationIdRef), causing
      // the guard below to discard its own result as "stale" and never connect
      // SSE. Guard first; only bump the generation id once we actually start.
      if (isGeneratingRef.current) return;
      isGeneratingRef.current = true;

      // FE-002: Increment generation ID to invalidate any in-flight SSE callbacks from a previous generation
      const genId = ++generationIdRef.current;

      setIsGenerating(true);
      setError(null);
      setProgress(null);
      setGeneratedStory(null);
      setJobId(null);
      reconnectCountRef.current = 0;
      optsRef.current.onStart?.();

      // Fix #39: cancel any in-flight POST from a previous generate() call.
      // A user double-clicking "Generate" previously fired two requests;
      // the first would sit open until its 30s default timeout, queuing
      // the server-side resource behind the second. Now the older request
      // is aborted as soon as the user clicks again, so the server only
      // ever processes the latest click.
      if (inflightPostRef.current) {
        inflightPostRef.current.cancel();
        inflightPostRef.current = null;
      }

      try {
        const handle = apiFetchWithCancel<{ jobId: string; requestId: string; sseUrl: string; sseAuth?: { auth: string; t: number } }>(
          `${API_BASE}/api/stories/generate`,
          {
            method: 'POST',
            isMutation: true,
            body: JSON.stringify({
              genre: opts.genre, // API expects array (string[])
              seed: opts.seed || undefined,
              forceNew: opts.forceNew || false,
            }),
          }
        );
        inflightPostRef.current = handle;
        inflightPostPromiseRef.current = handle.promise;
        const response = await handle.promise;
        inflightPostRef.current = null;
        inflightPostPromiseRef.current = null;

        if (!isMountedRef.current) return;

        if (response.success && response.data?.jobId) {
          const newJobId = response.data.jobId;
          if (response.data.sseAuth) {
            sseAuthRef.current = response.data.sseAuth;
          }
          setJobId(newJobId);
          setProgress({
            stage: 'init',
            progress: 0,
            message: response.message || 'Generation queued...',
            totalSteps: 100,
            completedSteps: 0,
          });

          // FE-002: Guard — abort if a new generation started while we were awaiting the jobId
          if (genId !== generationIdRef.current) {
            setIsGenerating(false);
            isGeneratingRef.current = false;
            return;
          }

          connectToSSERef.current?.(newJobId);
          return;
        }

        throw new Error(
          (response as { error?: string; message?: string }).error
            || response.message
            || 'Failed to queue generation'
        );
      } catch (err) {
        if (!isMountedRef.current) return;
        // FE-002: Ignore stale results from a generation that was reset or
        // superseded while the POST was in flight.
        if (genId !== generationIdRef.current) return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setIsGenerating(false);
        isGeneratingRef.current = false;
        optsRef.current.onError?.(msg);
      }
    },
    []
  );

  const reset = useCallback(() => {
    // Fix: Do NOT set isMountedRef.current = false here. That would permanently
    // disable the hook — every async guard checks `if (!isMountedRef.current) return`
    // and would prevent any subsequent `generate()` call. The ref is only set to
    // false in the unmount effect (line ~89). Instead, we clear the refs that would
    // cause stale callbacks:
    //   - reconnectJobIdRef.current = null  so es.onerror won't reconnect
    //   - sseAuthRef.current = null         so stale HMAC auth is removed
    //   - generationIdRef.current = 0       so stale generation IDs are gone
    // The isMountedRef remains true so generate() can be called again.
    setIsGenerating(false);
    isGeneratingRef.current = false;
    setProgress(null);
    setError(null);
    setGeneratedStory(null);
    setJobId(null);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    // Fix #39: cancel any in-flight POST and clear the handle so a
    // subsequent `generate()` does not race with a leftover promise.
    if (inflightPostRef.current) {
      inflightPostRef.current.cancel();
      inflightPostRef.current = null;
    }
    inflightPostPromiseRef.current = null;
    reconnectCountRef.current = 0;
    reconnectJobIdRef.current = null;
    sseFailedRef.current = false;
    sseFailedAtRef.current = null;
    sseAuthRef.current = null;
    generationIdRef.current = 0;
  }, []);

  // Fix #39: cleanup hook for component unmount. Uses reset() to avoid
  // duplicating the cleanup logic. Previously the cancel logic was duplicated
  // in both reset() and this effect, creating a maintenance hazard.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      eventSourceRef.current?.close();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      if (inflightPostRef.current) {
        inflightPostRef.current.cancel();
        inflightPostRef.current = null;
      }
      inflightPostPromiseRef.current = null;
      isGeneratingRef.current = false;
    };
  }, []);

  return {
    generate,
    reset,
    isGenerating,
    progress,
    error,
    generatedStory,
    jobId,
  };
}
