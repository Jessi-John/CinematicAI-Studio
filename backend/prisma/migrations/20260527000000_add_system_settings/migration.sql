-- Add system_settings table for DB-enforced pipeline thresholds
CREATE TABLE "system_settings" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "key" TEXT NOT NULL UNIQUE,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed initial threshold values; these are the source of truth for the pipeline.
-- To change a threshold, a developer must run a migration — not just edit a constant.
-- Uses raw SQL with DO NOTHING since the schema uses UNIQUE constraint, not a named index.
INSERT INTO "system_settings" ("key", "value") VALUES
  ('quality_floor', '70'),
  ('grade_floor', 'B'),
  ('humanization_score_limit', '80'),
  ('humanization_story_budget', '50'),
  ('humanization_story_quality_retries', '2')
ON CONFLICT ("key") DO NOTHING;