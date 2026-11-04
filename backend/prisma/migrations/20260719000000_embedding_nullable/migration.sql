-- Fix the degraded-persistence path: when the embedding provider is
-- unavailable, the pipeline persists stories with an empty embedding (the
-- background-embedding worker backfills it later). Two blockers made that
-- path fail before this migration:
--   1. Prisma's non-nullable list type rejects NULL embeddings at the client.
--   2. The HNSW index expression (embedding::vector(1024)) errors on 0-dim
--      arrays ("vector must have at least 1 dimension") for every insert.
-- Fix: default the column to '{}' and make the HNSW index partial so rows
-- without a 1024-dim embedding are never cast by the index.

ALTER TABLE "stories" ALTER COLUMN "embedding" SET DEFAULT '{}';

DROP INDEX IF EXISTS "stories_embedding_hnsw_idx";

CREATE INDEX "stories_embedding_hnsw_idx"
  ON "stories" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WITH (m = '16', ef_construction = '64')
  WHERE array_length("embedding", 1) = 1024;
