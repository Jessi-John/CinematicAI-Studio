-- CreateTable
CREATE TABLE "stories" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "seed" TEXT,
    "theme" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "targetAudience" TEXT,
    "plotStructure" JSONB,
    "embedding" DOUBLE PRECISION[],
    "youtubeTitle" TEXT,
    "youtubeDescription" TEXT,
    "youtubeTags" TEXT[],
    "thumbnailSuggestion" TEXT,
    "hookScript" TEXT,
    "algorithmTips" TEXT[],
    "viralPotential" INTEGER,
    "recommendedDuration" TEXT,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_seo" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[],
    "thumbnailSuggestions" TEXT[],
    "videoTemplate" TEXT NOT NULL DEFAULT '15s hook → 45s story → 5s CTA',
    "hookScript" TEXT NOT NULL,
    "algorithmBoostTips" TEXT[],
    "viralPotential" INTEGER NOT NULL DEFAULT 75,
    "recommendedDuration" TEXT NOT NULL DEFAULT '45-60 seconds',
    "targetAudience" TEXT NOT NULL DEFAULT 'Anime and cozy fantasy fans',
    "trendingKeywords" TEXT[],
    "ctaScript" TEXT NOT NULL DEFAULT 'Like and subscribe!',
    "storyId" TEXT NOT NULL,

    CONSTRAINT "youtube_seo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episodes" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "synopsis" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "cliffhanger" TEXT NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 50,
    "voiceoverScript" TEXT,
    "musicSuggestions" TEXT[],
    "soundDesign" TEXT[],
    "storyId" TEXT NOT NULL,

    CONSTRAINT "episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 15,
    "narrationText" TEXT NOT NULL,
    "narrationEmotion" TEXT,
    "narrationTiming" JSONB,
    "voiceoverNotes" TEXT,
    "imagePromptContent" TEXT NOT NULL,
    "imagePromptVersion" INTEGER NOT NULL DEFAULT 1,
    "imageModel" TEXT,
    "videoPromptContent" TEXT NOT NULL,
    "videoPromptVersion" INTEGER NOT NULL DEFAULT 1,
    "videoModel" TEXT,
    "cameraType" TEXT NOT NULL DEFAULT 'static',
    "cameraMovement" TEXT NOT NULL,
    "cameraAngle" TEXT NOT NULL DEFAULT 'medium',
    "cameraLens" TEXT NOT NULL DEFAULT 'standard',
    "emotionalIntensity" INTEGER NOT NULL DEFAULT 5,
    "transitionType" TEXT NOT NULL DEFAULT 'cut',
    "characterState" JSONB NOT NULL,
    "environmentState" JSONB NOT NULL,
    "visualNotes" TEXT,
    "audioNotes" TEXT,
    "episodeId" TEXT NOT NULL,

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "appearance" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "arc" TEXT,
    "speechPatterns" TEXT,
    "clothing" TEXT,
    "facialFeatures" TEXT,
    "emotions" TEXT[],
    "relationships" JSONB,
    "catchphrases" TEXT[],
    "physicalMannerisms" TEXT,
    "storyId" TEXT NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "weather" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "keyFeatures" TEXT[],
    "colorPalette" TEXT[],
    "lightingSetup" JSONB NOT NULL,
    "storyId" TEXT NOT NULL,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "storyId" TEXT,
    "episodeId" TEXT,
    "sceneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "similarity_cache" (
    "id" TEXT NOT NULL,
    "seedHash" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "themeHash" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "similarIds" TEXT[],
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "similarity_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stories_genre_idx" ON "stories"("genre");

-- CreateIndex
CREATE INDEX "stories_createdAt_idx" ON "stories"("createdAt");

-- CreateIndex
CREATE INDEX "stories_status_idx" ON "stories"("status");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_seo_storyId_key" ON "youtube_seo"("storyId");

-- CreateIndex
CREATE INDEX "episodes_storyId_idx" ON "episodes"("storyId");

-- CreateIndex
CREATE INDEX "scenes_episodeId_idx" ON "scenes"("episodeId");

-- CreateIndex
CREATE INDEX "characters_storyId_idx" ON "characters"("storyId");

-- CreateIndex
CREATE INDEX "environments_storyId_idx" ON "environments"("storyId");

-- CreateIndex
CREATE INDEX "generation_logs_storyId_idx" ON "generation_logs"("storyId");

-- CreateIndex
CREATE INDEX "generation_logs_createdAt_idx" ON "generation_logs"("createdAt");

-- CreateIndex
CREATE INDEX "similarity_cache_seedHash_idx" ON "similarity_cache"("seedHash");

-- CreateIndex
CREATE UNIQUE INDEX "similarity_cache_seedHash_genre_key" ON "similarity_cache"("seedHash", "genre");

-- AddForeignKey
ALTER TABLE "youtube_seo" ADD CONSTRAINT "youtube_seo_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_logs" ADD CONSTRAINT "generation_logs_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
