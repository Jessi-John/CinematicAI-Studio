/**
 * In-flight concept registry.
 *
 * Root-cause fix for cross-job title/motif collisions: stories only become
 * visible to the uniqueness analysis (stage 1) when they are persisted at the
 * END of the pipeline, so jobs running concurrently cannot see each other's
 * concepts. This produced near-identical titles in the same batch ("Static
 * Echo Protocol", "Voices in the Static", "The Silent Echo Chamber").
 *
 * The registry closes that window: after a blueprint is generated, its
 * significant title words and protagonist-name claims are atomically reserved
 * in Redis (SET NX) before the blueprint is accepted. A conflicting claim
 * forces regeneration with an explicit avoidance note. Claims carry a TTL so
 * a permanently failed job never blocks vocabulary forever, and the completed
 * story's title words continue to be avoided via the DB-backed analysis.
 *
 * All operations fail OPEN on Redis errors — uniqueness enforcement must
 * never break generation (same contract as the token-budget recorder).
 */

import { getSharedRedis } from '../lib/shared-redis.js';
import { logger } from './logger.js';

const CLAIM_TTL_SECONDS = 2 * 60 * 60; // comfortably outlives a pipeline run
const KEY_PREFIX = 'concept-claim:';

// Mirrors the stopword set used by the DB-backed uniqueness analysis so
// in-flight claims and post-completion avoidance use the same notion of a
// "significant" title word.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was',
  'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'journey', 'story', 'tale', 'episode', 'part', 'chapter',
]);

/**
 * Extract the claim tokens for a blueprint: significant title words
 * (lowercased alphanumeric, >3 chars, not stopwords), the full protagonist
 * name, and the protagonist first-name 3-char prefix (prevents near-identical
 * name families like Elren/Elis/Elise across concurrent jobs).
 */
export function extractClaimTokens(title: string, protagonistName?: string): string[] {
  const tokens = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 3 && !STOPWORDS.has(raw)) tokens.add(`title:${raw}`);
  }
  if (protagonistName) {
    const full = protagonistName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (full.length > 2) tokens.add(`name:${full}`);
    const first = full.split(' ')[0] ?? '';
    if (first.length >= 3) tokens.add(`name-prefix:${first.slice(0, 3)}`);
  }
  return Array.from(tokens);
}

/**
 * Atomically claim every token for this job. Returns the list of conflicting
 * tokens already owned by OTHER jobs. On conflict, any tokens this call newly
 * claimed are rolled back so the loser never holds partial claims. Tokens a
 * job already owns are re-claimed idempotently (retry-safe).
 */
export async function claimConceptTokens(jobId: string, tokens: string[]): Promise<string[]> {
  if (tokens.length === 0) return [];
  try {
    const redis = getSharedRedis();
    const newlyClaimed: string[] = [];
    const conflicts: string[] = [];
    for (const token of tokens) {
      const key = `${KEY_PREFIX}${token}`;
      const set = await redis.set(key, jobId, 'EX', CLAIM_TTL_SECONDS, 'NX');
      if (set === 'OK') {
        newlyClaimed.push(key);
        continue;
      }
      const owner = await redis.get(key);
      // M35: a claim whose TTL expired between SET NX and GET reads as
      // owner === null — that is NOT a conflict (previously forced a phantom
      // regeneration).
      if (owner !== null && owner !== jobId) conflicts.push(token);
    }
    if (conflicts.length > 0) {
      // Roll back only what THIS call claimed — tokens the job owned from an
      // earlier attempt must survive for its next retry.
      if (newlyClaimed.length > 0) {
        try {
          await redis.del(...newlyClaimed);
        } catch (err) {
          logger.warn({ err, jobId }, 'Concept-claim rollback failed — claims will expire via TTL');
        }
      }
      return conflicts;
    }
    return [];
  } catch (err) {
    logger.warn({ err, jobId }, 'Concept registry unavailable — proceeding without in-flight claims');
    return [];
  }
}

/** List all tokens currently claimed by other jobs (for prompt constraints). */
export async function getClaimedConceptTokens(excludeJobId?: string): Promise<string[]> {
  try {
    const redis = getSharedRedis();
    const tokens: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        const owners = await redis.mget(...keys);
        keys.forEach((key, i) => {
          // M35: keys that expired between SCAN and MGET read as null —
          // skip them; they are not live constraints.
          if (owners[i] === null) return;
          if (!excludeJobId || owners[i] !== excludeJobId) {
            tokens.push(key.slice(KEY_PREFIX.length));
          }
        });
      }
    } while (cursor !== '0');
    return tokens;
  } catch (err) {
    logger.warn({ err }, 'Concept registry unavailable — skipping in-flight motif constraints');
    return [];
  }
}

/** Human-readable form of claimed tokens for prompt constraints. */
export function formatClaimedTokensForPrompt(tokens: string[]): string[] {
  const titleWords = tokens.filter((t) => t.startsWith('title:')).map((t) => t.slice('title:'.length));
  const namePrefixes = tokens.filter((t) => t.startsWith('name-prefix:')).map((t) => t.slice('name-prefix:'.length));
  const constraints: string[] = [];
  if (titleWords.length > 0) {
    constraints.push(`Avoid title words currently claimed by other stories being generated right now: ${titleWords.join(', ')}`);
  }
  if (namePrefixes.length > 0) {
    constraints.push(`Avoid protagonist names starting with these prefixes (claimed by concurrent generations): ${namePrefixes.join(', ')}`);
  }
  return constraints;
}
