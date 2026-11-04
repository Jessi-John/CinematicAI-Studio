-- M30: Cache episode and scene counts on stories table.
-- The list view (LIST_SELECT) reads these scalars instead of loading the
-- full episodes/scenes tree (which multiplies row count by 10-50x per story).
-- buildStoryCreateData writes these counts in-memory at save time, so they
-- cannot drift from reality for new stories.
--
-- Backfill: count episodes and scenes for existing stories so the list view
-- returns correct totals immediately. This is safe because both columns
-- have DEFAULT 0 and the only places that read them are the list view and
-- the convertStory metadata builder (which falls back to the cached value
-- when episodes[] is not loaded).
ALTER TABLE "stories"
  ADD COLUMN IF NOT EXISTS "episodeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sceneCount"   INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing data. Wrapped in a single statement per column
-- so a partial failure does not leave the table in a half-backfilled state.
UPDATE "stories" s
   SET "episodeCount" = COALESCE(sub.cnt, 0)
  FROM (
    SELECT "storyId", COUNT(*)::int AS cnt
      FROM "episodes"
     GROUP BY "storyId"
  ) sub
 WHERE s.id = sub."storyId"
   AND s."episodeCount" = 0;

UPDATE "stories" s
   SET "sceneCount" = COALESCE(sub.cnt, 0)
  FROM (
    SELECT e."storyId", COUNT(sc.id)::int AS cnt
      FROM "episodes" e
      LEFT JOIN "scenes" sc ON sc."episodeId" = e.id
     GROUP BY e."storyId"
  ) sub
 WHERE s.id = sub."storyId"
   AND s."sceneCount" = 0;
