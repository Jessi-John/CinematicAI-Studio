/**
 * Embedding generation via Mistral AI mistral-embed-2312 (1024-dim).
 * Model outputs 1024-dim vectors, matching the pgvector HNSW index schema.
 *
 * Mistral endpoint: https://api.mistral.ai/v1/embeddings
 * Model: mistral-embed-2312 — 1024-dim vectors (matches DB schema directly).
 *
 * Results are cached in Redis (keyed by SHA256 of normalized text) since story
 * embeddings are immutable after creation. Entries carry a 90-day TTL
 * (EMBEDDING_CACHE_TTL_SECONDS) to bound Redis memory growth; see PERF-004 below.
 */

import crypto from 'node:crypto';
import { logger } from '../services/logger.js';
import { getSharedRedis } from './shared-redis.js';
import { isCannedMode, cannedEmbedding } from './ai-client.canned.js';
import { createWatchdogAbortController } from './watchdog.js';
import { checkAndRecordTokenBudget, refundTokenBudget } from '../services/token-budget.js';
import { getMistralApiKey, getMistralBaseUrl, getEmbeddingModel, isPlaceholder } from '../config/env.js';
import {
  getCurrentAIPipelineJobId,
  __checkMistralCircuitBreaker,
  __recordMistralEmbeddingFailure,
  __recordMistralEmbeddingSuccess,
  __waitForRateLimit,
  mistralRateLimiter,
} from './ai-client.js';

const EMBEDDING_TIMEOUT_MS = 20000;

// Fix #31: Embedding cache key version. Bump this when the normalization
// function (or any input the hash covers) changes — otherwise stale entries
// from the previous version will be returned indefinitely until the 90-day
// TTL expires. Bumping creates a fresh key space, so old keys simply expire.
const CACHE_KEY_VERSION = 1;
const CACHE_KEY_PREFIX = `embedding:v${CACHE_KEY_VERSION}:`;

interface MistralEmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens: number; total_tokens: number };
  error?: { message: string; type: string };
}

function isValidMistralApiKey(): boolean {
  const key = getMistralApiKey();
  if (!key) return false;
  // Must match ai-client.ts isValidMistralApiKey threshold (> 10 chars) —
  // previously `< 10` here vs `> 10` there, so a 10-char key enabled
  // embeddings but not chat. Unified on the ai-client rule.
  const trimmed = key.trim();
  if (trimmed.length <= 10) return false;
  if (isPlaceholder(trimmed)) return false;
  return true;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

function getCacheKey(text: string): string {
  return `${CACHE_KEY_PREFIX}${hashText(text)}`;
}

async function getCached(key: string): Promise<number[] | null> {
  try {
    const r = await getSharedRedis().get(key);
    return r ? (JSON.parse(r) as number[]) : null;
  } catch {
    return null;
  }
}

// PERF-004: Embedding cache entries now have a 90-day TTL. While embeddings are
// semantically immutable (same text → same embedding), a TTL prevents unbounded
// Redis memory growth from abandoned or changed content over time. 90 days is
// long enough for any realistic cache hit scenario while providing a safety valve.
const EMBEDDING_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function setCache(key: string, vec: number[]): void {
  getSharedRedis()
    .set(key, JSON.stringify(vec), 'EX', EMBEDDING_CACHE_TTL_SECONDS)
    .catch((err) => logger.warn({ err }, 'Redis cache set failed'));
}

async function callMistralEmbeddingApi(text: string): Promise<number[] | null> {
  // Fix: Check the Mistral circuit breaker before making the API call.
  // Previously, embedding calls bypassed the circuit breaker entirely
  // and made raw fetch() calls to Mistral, undermining the protection
  // during Mistral outages. Now we check the breaker (which may
  // transition to half-open for probing) and record success/failure.
  try {
    __checkMistralCircuitBreaker();
  } catch {
    logger.warn('Mistral circuit breaker open — skipping embedding API call');
    return null;
  }

  // Fix: Await the same Mistral rate limiter that chat completions use.
  // Previously, embedding calls had no rate limiting at all, allowing
  // them to burst past the 20 req/min limit during embedding-heavy
  // operations. Now they respect the same budget.
  await __waitForRateLimit(mistralRateLimiter);

  // PR-001 / REL-006: use worker-thread watchdog for the abort signal.
  const wd = createWatchdogAbortController(EMBEDDING_TIMEOUT_MS, 'embed_mistral');
  const startNs = process.hrtime.bigint();
  logger.info(
    { provider: 'Mistral', timeoutMs: EMBEDDING_TIMEOUT_MS, textChars: text.length, jobId: getCurrentAIPipelineJobId() },
    'EMBED_ATTEMPT_STARTED'
  );

  try {
    const response = await fetch(`${getMistralBaseUrl()}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getMistralApiKey()}`,
      },
      body: JSON.stringify({
        model: getEmbeddingModel(),
        input: [text],
        encoding_format: 'float',
      }),
      signal: wd.controller.signal,
    });
    wd.cancel();
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    logger.info(
      { provider: 'Mistral', status: response.status, elapsedMs: Math.round(elapsedMs), jobId: getCurrentAIPipelineJobId() },
      'EMBED_ATTEMPT_HTTP_RESPONSE'
    );

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Mistral embedding API non-OK response');
      await __recordMistralEmbeddingFailure();
      return null;
    }

    const data = (await response.json()) as MistralEmbeddingResponse;

    if (data.error) {
      logger.warn({ err: data.error.message }, 'Mistral embedding API error');
      await __recordMistralEmbeddingFailure();
      return null;
    }

    const vec = data.data?.[0]?.embedding;
    if (!vec || !Array.isArray(vec) || vec.length === 0) {
      logger.warn('Mistral embedding API returned no vector');
      await __recordMistralEmbeddingFailure();
      return null;
    }

    __recordMistralEmbeddingSuccess();
    return vec;
  } catch (err) {
    wd.cancel();
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    logger.warn(
      { provider: 'Mistral', elapsedMs: Math.round(elapsedMs), err: String(err).slice(0, 200), jobId: getCurrentAIPipelineJobId() },
      'EMBED_ATTEMPT_FAILED'
    );
    await __recordMistralEmbeddingFailure();
    return null;
  }
}

/**
 * Generate embedding for the given text.
 * Cache hit → instant return from Redis.
 * Cache miss → Mistral AI mistral-embed-2312 (1024-dim, matches DB).
 * Mistral fail → null (caller falls back to lexical dedup).
 */
export async function generateEmbedding(text: string, jobId?: string): Promise<number[] | null> {
  if (!text || text.trim().length === 0) return null;

  // Bypass real API when STORY_TEST_MODE=canned (test environments only).
  if (isCannedMode()) {
    const vec = cannedEmbedding(text);
    // Persist to cache so downstream code paths see the same key
    setCache(getCacheKey(text), vec);
    return vec;
  }

  const cacheKey = getCacheKey(text);
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // Fix #18: Record against the token budget BEFORE making the API call.
  // Mistral embedding API does not return token usage in its response,
  // usage in their standard responses, so we estimate: 1 token ≈ 4
  // characters for English text. This is the same heuristic used by
  // the OpenAI cookbook and is accurate to within ~10% for natural
  // language. We record both prompt (input) and completion (= 0 for
  // embeddings, but the budget ledger treats them symmetrically for
  // accounting). If the budget rejects, return null — the caller falls
  // back to lexical dedup.
  const estimatedTokens = Math.ceil(text.length / 4);
  const budget = await checkAndRecordTokenBudget(estimatedTokens, 0, jobId);
  if (!budget.ok) {
    logger.warn(
      { estimatedTokens, reason: budget.reason },
      'Token budget rejected embedding — falling back to lexical dedup'
    );
    return null;
  }

  let vec: number[] | null = null;

  try {
    if (isValidMistralApiKey()) {
      vec = await callMistralEmbeddingApi(text.slice(0, 32768));
    }
  } catch (err) {
    // API failure: refund the estimated charge so retries and future
    // embeddings are not permanently starved.
    if (jobId) await refundTokenBudget(jobId, estimatedTokens, 0);
    logger.warn({ err: String(err).slice(0, 200), jobId }, 'Embedding generation failed — refunded token budget');
    return null;
  }

  // Validate and normalize dimensions BEFORE caching or returning.
  // Mistral mistral-embed-2312 outputs 1024-dim vectors, which matches
  // the pgvector HNSW index schema. Reject unexpected dimensions.
  const EXPECTED_DIM = 1024;
  if (vec && vec.length !== EXPECTED_DIM) {
    if (vec.length > EXPECTED_DIM) {
      logger.debug({ actualDim: vec.length, targetDim: EXPECTED_DIM }, 'Truncating embedding to match DB schema');
      vec = vec.slice(0, EXPECTED_DIM);
    } else {
      logger.warn(
        { actualDim: vec.length, expectedDim: EXPECTED_DIM },
        'Embedding vector too short — rejecting to protect pgvector index'
      );
      vec = null;
    }
  }

  if (vec && vec.length > 0) {
    setCache(cacheKey, vec);
  } else if (jobId) {
    // No usable vector produced — refund the charge.
    await refundTokenBudget(jobId, estimatedTokens, 0);
  }

  return vec;
}
