-- MIGRATION: Add CHECK constraints on enum-like string columns
--
-- These columns are constrained by application logic but had no DB-level
-- enforcement. Adding CHECK constraints ensures data integrity even if
-- application code has bugs, or when data is inserted/updated outside
-- the application (e.g., manual SQL, scripts).

-- 1. stories.status — must be a valid story lifecycle state
-- Values used by the application: draft (initial), generating (in-progress),
-- complete (successfully generated), failed (generation error).
ALTER TABLE "stories" ADD CONSTRAINT "stories_status_check"
  CHECK ("status" IN ('draft', 'generating', 'complete', 'failed'));

-- 2. characters.role — must be a valid narrative role
ALTER TABLE "characters" ADD CONSTRAINT "characters_role_check"
  CHECK ("role" IN ('protagonist', 'antagonist', 'supporting', 'minor'));

-- 3. characters.gender — must be a valid gender for pronoun generation
ALTER TABLE "characters" ADD CONSTRAINT "characters_gender_check"
  CHECK ("gender" IN ('male', 'female', 'neutral'));

-- 4. users.role — must be a valid authorization role
ALTER TABLE "users" ADD CONSTRAINT "users_role_check"
  CHECK ("role" IN ('admin', 'user'));
