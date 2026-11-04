-- M24: Add FK constraints on generation_logs.episodeId and sceneId
-- The columns had indexes but no FK constraints, allowing orphaned rows.
-- Use IF NOT EXISTS guard since some environments may already have these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generation_logs_episodeId_fkey') THEN
    ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_episodeId_fkey"
      FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generation_logs_sceneId_fkey') THEN
    ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_sceneId_fkey"
      FOREIGN KEY ("sceneId") REFERENCES "scenes"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- M25: Add userId column to stories (if missing) + FK constraint
-- The userId column exists in the Prisma schema as optional (String?) but
-- was never added to the DB table. Add it before creating the FK.
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "userId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stories_userId_fkey') THEN
    ALTER TABLE "stories" ADD CONSTRAINT "stories_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- M13: Make user_settings per-user instead of global
-- Add userId column with default 'global' for backward compatibility
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "userId" TEXT NOT NULL DEFAULT 'global';

-- Create index for userId lookups (IF NOT EXISTS guard)
CREATE INDEX IF NOT EXISTS "user_settings_userId_idx" ON "user_settings"("userId");

-- Drop the old unique constraint on key alone
ALTER TABLE "user_settings" DROP CONSTRAINT IF EXISTS "user_settings_key_key";

-- Create a new unique constraint on (userId, key)
CREATE UNIQUE INDEX IF NOT EXISTS "user_settings_userId_key_key" ON "user_settings"("userId", "key");
