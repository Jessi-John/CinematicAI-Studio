-- MIGRATION: Add user_settings.userId FK constraint
--
-- Root-cause fix for orphaned user_settings rows when a user is deleted.
-- 1. Create a dedicated 'global' user to own existing system-wide settings.
-- 2. Backfill all rows with userId = 'global' (the current default).
-- 3. Add FK constraint with ON DELETE CASCADE so per-user settings are
--    cleaned up when a user is removed.

-- 1. Ensure the 'global' user exists. Invalid bcrypt hash prevents login.
--    L16: role is 'user' (not 'admin') so a compromised synthetic account
--    cannot exercise admin privileges even if the login guard is bypassed.
INSERT INTO "users" ("id", "username", "passwordHash", "role", "createdAt", "updatedAt")
VALUES (
  'global',
  'global',
  '$2b$12$./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0',
  'user',
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

-- 2. Backfill any rows that might have a different userId to point to 'global'
--    (should not be needed as default is 'global', but ensures consistency).
UPDATE "user_settings" SET "userId" = 'global' WHERE "userId" != 'global' AND "userId" NOT IN (SELECT "id" FROM "users");

-- 3. Add FK constraint with ON DELETE CASCADE.
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
