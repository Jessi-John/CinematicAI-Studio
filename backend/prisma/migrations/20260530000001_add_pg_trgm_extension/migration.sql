-- Enable pg_trgm extension for trigram-based fuzzy text matching.
-- Used by similarity.ts findDuplicateLexical() for lexical similarity
-- via pg_trgm similarity() > 0.72 threshold.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Functional gin index for fast ILIKE / similarity() queries on story titles.
-- Supports findDuplicateLexical() in similarity.ts without sequential scan.
CREATE INDEX IF NOT EXISTS "stories_title_trgm_idx" ON "stories"
  USING gin ("title" gin_trgm_ops);