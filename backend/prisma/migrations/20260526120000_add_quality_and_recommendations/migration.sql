-- Persist quality scores, humanization scores, and story-specific recommendations.
-- Idempotent: safe to re-run.

ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "qualityScore"           INTEGER;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "qualityGrade"           TEXT;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "humanizationScore"      INTEGER;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "qualityRecommendations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "qualityIssues"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "algorithmTips"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "alternateTitles"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Plain-prose voiceover text suitable for direct TTS ingestion.
-- "voiceoverScript" remains as the human-readable annotated script.
ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "voiceoverText" TEXT;

-- Backfill voiceoverText from voiceoverScript by stripping labels.
UPDATE "episodes"
SET "voiceoverText" = regexp_replace(COALESCE("voiceoverScript", ''), '\[(HOOK|CLIFFHANGER|Scene[^\]]*)\]\s*', '', 'g')
WHERE "voiceoverText" IS NULL AND "voiceoverScript" IS NOT NULL;
