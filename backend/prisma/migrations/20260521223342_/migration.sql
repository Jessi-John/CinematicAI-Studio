-- AlterTable
ALTER TABLE "stories" ADD COLUMN     "isTemplate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "storyArcType" TEXT NOT NULL DEFAULT 'classic',
ADD COLUMN     "templateId" TEXT;

-- CreateIndex
CREATE INDEX "stories_isTemplate_idx" ON "stories"("isTemplate");
