-- CRITICAL-1: Change the default user role from 'admin' to 'user'.
-- New users created without an explicit role will now be regular users.
--
-- Existing users are intentionally NOT modified: we cannot distinguish
-- legitimate administrators from users that incorrectly received the admin
-- default. After deploying this migration, review existing 'admin' rows and
-- demote any that should not have administrative access.

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user';
