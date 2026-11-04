-- Add updatedAt to characters, environments, episodes, scenes, youtube_seo
-- REL-010: All these models have updatedAt DateTime @updatedAt in schema.prisma,
-- but the original migrations did not include the column. The worker was crashing
-- at the final prisma.story.create() call because nested creates on characters,
-- environments, episodes, scenes, and youtube_seo all reference updatedAt, which
-- the DB rejected with P2022: "The column updatedAt does not exist in the current database."
-- Discovered during Phase 1 Group 3 test on 2026-06-06.
ALTER TABLE "characters" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "environments" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "episodes" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "scenes" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "youtube_seo" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
