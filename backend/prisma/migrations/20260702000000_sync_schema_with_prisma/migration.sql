-- DropForeignKey
ALTER TABLE "generation_logs" DROP CONSTRAINT "generation_logs_episodeId_fkey";

-- DropForeignKey
ALTER TABLE "generation_logs" DROP CONSTRAINT "generation_logs_sceneId_fkey";

-- DropForeignKey
ALTER TABLE "stories" DROP CONSTRAINT "stories_userId_fkey";

-- DropForeignKey
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_userId_fkey";

-- DropIndex
DROP INDEX "generation_logs_createdAt_idx";

-- DropIndex
DROP INDEX "generation_logs_storyId_idx";

-- DropIndex
DROP INDEX "stories_isTemplate_idx";

-- DropIndex
DROP INDEX "stories_seedStoryId_idx";

-- DropIndex
DROP INDEX "stories_title_trgm_idx";

-- DropIndex
DROP INDEX "user_settings_key_idx";

-- AlterTable
ALTER TABLE "characters" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "environments" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "episodes" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "generation_logs" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scenes" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stories" ALTER COLUMN "plotStructure" SET DATA TYPE TEXT,
ALTER COLUMN "youtubeTags" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "isTemplate" DROP NOT NULL,
ALTER COLUMN "storyArcType" DROP NOT NULL,
ALTER COLUMN "storyArcType" DROP DEFAULT,
ALTER COLUMN "qualityRecommendations" DROP DEFAULT,
ALTER COLUMN "qualityIssues" DROP DEFAULT,
ALTER COLUMN "alternateTitles" DROP DEFAULT;

-- AlterTable
ALTER TABLE "system_settings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "youtube_seo" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "episodes_storyId_number_key" ON "episodes"("storyId", "number");

-- CreateIndex
CREATE INDEX "generation_logs_storyId_createdAt_idx" ON "generation_logs"("storyId", "createdAt");

-- CreateIndex
CREATE INDEX "scenes_episodeId_number_idx" ON "scenes"("episodeId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "scenes_episodeId_number_key" ON "scenes"("episodeId", "number");

-- AddForeignKey
ALTER TABLE "stories" ADD CONSTRAINT "stories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

