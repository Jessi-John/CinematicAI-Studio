-- L18: persist real stage8-quality sub-scores and prompt timestamps instead of
-- fabricating them in converters.ts.

ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "monetizationScore" INTEGER;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "viralityScore" INTEGER;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "retentionScore" INTEGER;
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "hookStrength" INTEGER;

ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "imagePromptCreatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "scenes" ADD COLUMN IF NOT EXISTS "videoPromptCreatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
