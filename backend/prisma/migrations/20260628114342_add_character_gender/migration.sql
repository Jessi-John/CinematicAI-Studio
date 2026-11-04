-- M31: Add gender column to characters table.
-- The character-bible AI returns a gender field (male/female/neutral)
-- since M31. Storing it on the Character row lets downstream consumers
-- (scene narration prompts, frontend display) read it directly instead
-- of re-deriving from the name. DEFAULT 'neutral' means existing
-- character rows continue to be valid without a backfill — "they" is
-- the safe pronoun for a character whose gender is not recorded.
ALTER TABLE "characters"
  ADD COLUMN IF NOT EXISTS "gender" TEXT NOT NULL DEFAULT 'neutral';
