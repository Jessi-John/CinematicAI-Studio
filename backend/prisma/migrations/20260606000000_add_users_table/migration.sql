-- Create users table
-- REL-006: The User model was added to schema.prisma (mapped to "users") but no
-- migration created the table. On 2026-06-06, a cold-start Docker test revealed
-- this gap when the backend crashed on first auth attempt with
-- "Invalid `prisma.user.findUnique()` invocation: The table `public.users`
-- does not exist in the current database." This migration creates the table
-- matching the User model definition.
--
-- Note: there is a foreign-key-style relationship via username in some other
-- tables, but reviewing the current schema, no FK is defined on User. If FKs
-- are added later, they belong in a separate migration.

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on username (matches @unique in schema)
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
