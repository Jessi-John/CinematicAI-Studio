-- MIGRATION: Require non-null story ownership
--
-- Root-cause fix for anonymous stories being world-readable/exportable.
-- 1. Create a dedicated System user to own any legacy anonymous stories.
-- 2. Backfill all stories with NULL userId to the System user.
-- 3. Make userId NOT NULL with a default of 'system' as a safety net.
-- 4. Drop the old SET NULL rule and enforce RESTRICT so users with stories
--    cannot be deleted (preserving the invariant).

-- 1. Ensure the System user exists. The password hash is a deliberately
--    invalid bcrypt string so this account cannot be used to log in.
--    L16: role is 'user' (not 'admin') so a compromised synthetic account
--    cannot exercise admin privileges even if the login guard is bypassed.
INSERT INTO "users" ("id", "username", "passwordHash", "role", "createdAt", "updatedAt")
VALUES (
  'system',
  'system',
  '$2b$12$./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0',
  'user',
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

-- 2. Backfill anonymous stories to the System user.
UPDATE "stories" SET "userId" = 'system' WHERE "userId" IS NULL;

-- 3. Enforce non-null ownership going forward.
ALTER TABLE "stories" ALTER COLUMN "userId" SET DEFAULT 'system';
ALTER TABLE "stories" ALTER COLUMN "userId" SET NOT NULL;

-- 4. Replace the previous ON DELETE SET NULL behavior with RESTRICT.
--    (The FK name is inferred from the previous migration.)
ALTER TABLE "stories" DROP CONSTRAINT IF EXISTS "stories_userId_fkey";
ALTER TABLE "stories" ADD CONSTRAINT "stories_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT;

-- 5. Ensure the index declared by @@index([userId]) in schema.prisma exists.
CREATE INDEX IF NOT EXISTS "stories_userId_idx" ON "stories"("userId");
