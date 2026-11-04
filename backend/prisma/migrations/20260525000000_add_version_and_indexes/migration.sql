-- Add optimistic-locking version columns
ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scenes"   ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- Add similarity_cache.updatedAt and themeHash index (older migration may have missed updatedAt)
-- NOTE: similarity_cache table was dropped in 20260528000001_drop_similarity_cache.sql
-- These lines are kept as historical record only - do not apply

-- Indexes (idempotent)
CREATE INDEX IF NOT EXISTS "generation_logs_episodeId_idx"  ON "generation_logs"("episodeId");
CREATE INDEX IF NOT EXISTS "generation_logs_sceneId_idx"    ON "generation_logs"("sceneId");

-- Ensure characters.relationships is JSONB nullable (older migration created it; keep idempotent)
-- (No-op if already correct.)
