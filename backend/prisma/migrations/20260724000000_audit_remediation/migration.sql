-- Audit remediation bundle (2026-07-24).
-- 1. M1: sceneCount drift fix — denormalize scenes.storyId so the decrement
--    trigger no longer depends on the (already-deleted) episodes row.
-- 2. M2: recreate the pg_trgm GIN index dropped by the 20260702000000 sync
--    migration (list search + lexical duplicate detection).
-- 3. M5: functional index on lower(characters.name) for the protagonist-name
--    uniqueness check inside Serializable transactions.
-- 4. H2-residual: backfill NULL embeddings and enforce NOT NULL to match the
--    Prisma schema (Float[] @default([])).
-- 5. L9: drop indexes redundant with unique compound indexes (write
--    amplification on the hottest write path).

-- 1a. scenes.storyId denormalized column
ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "storyId" TEXT;
UPDATE "scenes" s SET "storyId" = e."storyId" FROM "episodes" e WHERE s."episodeId" = e.id AND s."storyId" IS NULL;
ALTER TABLE "scenes" ALTER COLUMN "storyId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "scenes_storyId_idx" ON "scenes"("storyId");

-- 1b. Fix the decrement trigger to use the denormalized column (the old one
-- queried "episodes" for a row already cascade-deleted in the same statement,
-- so the decrement was skipped and sceneCount drifted upward forever).
CREATE OR REPLACE FUNCTION decrement_story_scene_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE "stories"
    SET "sceneCount" = GREATEST(0, "sceneCount" - 1)
    WHERE id = OLD."storyId";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- 2. M2: recreate trgm index. Guard: Prisma diffs cannot express GIN/trigram
-- indexes — DO NOT let future sync migrations drop this (see the PERF-006
-- note in schema.prisma).
CREATE INDEX IF NOT EXISTS "stories_title_trgm_idx" ON "stories" USING gin ("title" gin_trgm_ops);

-- 3. M5: functional index for case-insensitive protagonist-name lookups.
CREATE INDEX IF NOT EXISTS "characters_lower_name_idx" ON "characters" (lower("name"));

-- 4. H2-residual: backfill and constrain.
UPDATE "stories" SET "embedding" = '{}' WHERE "embedding" IS NULL;
ALTER TABLE "stories" ALTER COLUMN "embedding" SET NOT NULL;

-- 5. L9: drop redundant indexes (unique compound covers the leftmost prefix).
DROP INDEX IF EXISTS "episodes_storyId_idx";
DROP INDEX IF EXISTS "scenes_episodeId_idx";
DROP INDEX IF EXISTS "scenes_episodeId_number_idx";
