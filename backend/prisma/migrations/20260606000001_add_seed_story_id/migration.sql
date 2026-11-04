-- Add seedStoryId column to stories
-- REL-007: The Story model was updated to add a self-referential seedStoryId
-- column (with @@relation("StorySeeds")) but no migration was created to add
-- the column to the database. On 2026-06-06, a cold-start Docker test revealed
-- this gap when GET /api/stories returned 500 with
-- "The column `stories.seedStoryId` does not exist in the current database."
-- This migration adds the column.

ALTER TABLE "stories" ADD COLUMN "seedStoryId" TEXT;

-- Self-referential FK with onDelete SetNull (per schema)
-- Use IF NOT EXISTS to be idempotent on re-runs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stories_seedStoryId_fkey'
  ) THEN
    ALTER TABLE "stories"
      ADD CONSTRAINT "stories_seedStoryId_fkey"
      FOREIGN KEY ("seedStoryId")
      REFERENCES "stories"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

-- Index for fast lookup (matches the implicit index Prisma would create
-- for the FK)
CREATE INDEX IF NOT EXISTS "stories_seedStoryId_idx" ON "stories"("seedStoryId");
