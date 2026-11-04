-- M32: Replace the (genre, seed) partial unique index with a dedicated
-- deduplicationKey column so that forceNew=true can intentionally bypass
-- the constraint while accidental exact duplicates are still blocked.
--
-- The partial unique index on (genre, deduplicationKey) WHERE deduplicationKey
-- IS NOT NULL preserves the TOCTOU protection from 20260611000000. When a user
-- passes forceNew=true, the application sets deduplicationKey to a unique value
-- (seed + jobId), so the insert succeeds even if the same seed already exists.

-- Add the new column (NULL until backfilled).
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "deduplicationKey" TEXT;

-- Backfill existing rows: use the current seed as the deduplication key so the
-- new index covers them and duplicates of existing concepts are still blocked.
-- Dedupe-safe: if legacy duplicate (genre, seed) rows somehow exist (e.g. a DB
-- predating the 20260611000000 partial index), only the oldest row per
-- (genre, seed) keeps the seed as its key; the rest are left NULL so they fall
-- outside the partial unique index (WHERE deduplicationKey IS NOT NULL) and the
-- index creation below cannot fail on them.
UPDATE "stories"
SET "deduplicationKey" = seed
WHERE "deduplicationKey" IS NULL
  AND seed IS NOT NULL
  AND id IN (
    SELECT DISTINCT ON ("genre", seed) id
    FROM "stories"
    WHERE seed IS NOT NULL
    ORDER BY "genre", seed, "createdAt" ASC, id ASC
  );

-- Drop the old partial unique index on (genre, seed).
DROP INDEX IF EXISTS "stories_genre_seed_unique_idx";

-- Create the new partial unique index on (genre, deduplicationKey).
CREATE UNIQUE INDEX IF NOT EXISTS "stories_genre_dedup_key_idx"
  ON "stories" ("genre", "deduplicationKey")
  WHERE "deduplicationKey" IS NOT NULL;
