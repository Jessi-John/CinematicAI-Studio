-- Drop SimilarityCache table (replaced by pgvector HNSW index)
-- First disable triggers to avoid FK issues during drop
ALTER TABLE "similarity_cache" DISABLE TRIGGER ALL;
DROP TABLE IF EXISTS "similarity_cache";