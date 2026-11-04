-- Add updatedAt column to generation_logs
-- REL-009: GenerationLog model has updatedAt DateTime @updatedAt in schema,
-- but no migration created the column. On 2026-06-06, a cold-start Docker
-- test revealed this gap when worker logged:
--   Invalid `prisma.generationLog.create()` invocation:
--   The column `updatedAt` does not exist in the current database.
-- Generation logs were silently failing, breaking pipeline progress tracking.
ALTER TABLE "generation_logs" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
