-- pgvector Migration
-- Prisma schema keeps embedding as Float[] for type safety.
-- The actual column is cast to vector(1024) in queries via ::vector casting.
-- This migration creates the HNSW index on the cast expression.
-- PERF-002/REL-005: pgvector HNSW has a HARD 2000-dim limit. The MiniMax embo-01
-- embedding model returns 1024-dim vectors, so the index MUST be on vector(1024).
-- A previous version used vector(4096) which silently fails on every cold start
-- with "column cannot have more than 2000 dimensions for hnsw index" — the
-- migration was left in a stuck state, the backend crashed in a loop, and no
-- similarity detection worked. The dimension is now hardcoded to 1024 to match
-- the embedding model. If the model is ever swapped, this migration MUST be
-- updated before redeploy or this crash will recur.

-- Step 1: Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create HNSW index using ::vector cast
-- The index uses the casting syntax so it works with Float[] in Prisma schema
-- but pgvector's HNSW algorithm over the vector type.
-- m=16, ef_construction=64 gives good recall at moderate build time.
-- REL-005: 1024 dim matches MiniMax embo-01 output. DO NOT change to 4096.
CREATE INDEX IF NOT EXISTS "stories_embedding_hnsw_idx" ON "stories"
  USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Verify pgvector and index
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE WARNING 'pgvector extension not found — ensure your Postgres provider supports it (Supabase does by default).';
  ELSE
    RAISE NOTICE 'pgvector ready. HNSW index on embedding (1024-dim) created.';
  END IF;
END $$;