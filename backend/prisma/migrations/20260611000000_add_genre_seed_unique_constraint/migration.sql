-- Unique constraint on (genre, seed) to prevent duplicate story concepts.
-- The partial index (WHERE seed IS NOT NULL) ensures we only enforce
-- uniqueness for stories with an explicit seed — stories with NULL seed
-- (anonymous/generated) are not constrained.
--
-- This closes the TOCTOU race window where two concurrent /api/stories/generate
-- requests with the same seed would both pass the application-level
-- findDuplicateConcept check and both get 202-accepted. With this constraint,
-- the second insertion will fail with a unique_violation error, which both
-- the route handler and the worker handle gracefully (409 or job failure).

-- Drop existing index if present (handles re-runs)
DROP INDEX IF EXISTS "stories_genre_seed_unique_idx";

-- Partial unique index: only applies when seed is not null
CREATE UNIQUE INDEX "stories_genre_seed_unique_idx"
  ON "stories" ("genre", "seed")
  WHERE "seed" IS NOT NULL;