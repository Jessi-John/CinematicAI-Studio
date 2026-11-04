-- 20260526120000 used ADD COLUMN IF NOT EXISTS on a column that
-- 20260521165856 had already created, so the intended default never
-- landed. Restore it and backfill rows written in the meantime.
UPDATE "stories" SET "algorithmTips" = ARRAY[]::TEXT[] WHERE "algorithmTips" IS NULL;

ALTER TABLE "stories" ALTER COLUMN "algorithmTips" SET DEFAULT ARRAY[]::TEXT[];
