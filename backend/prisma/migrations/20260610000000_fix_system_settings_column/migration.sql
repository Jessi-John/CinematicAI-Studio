-- DATA-002: Sync DB column with Prisma model.
-- The 20260527000000_add_system_settings migration created the column as
-- "updated_at" (snake_case) but the Prisma model declared it as "updatedAt"
-- with @updatedAt, which caused upsert() to fail with P2022 ("column does not
-- exist"). This migration renames the column to match the Prisma model
-- expectation. The Prisma schema in this repo is also fixed (uses camelCase).
ALTER TABLE "system_settings" RENAME COLUMN "updated_at" TO "updatedAt";
