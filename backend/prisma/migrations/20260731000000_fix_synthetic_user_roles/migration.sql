-- L16: synthetic service accounts must never have admin privileges.
-- The original migrations inserted 'system' and 'global' with role='admin';
-- this migration corrects any existing rows and guards fresh deployments.
UPDATE "users" SET "role" = 'user' WHERE "id" IN ('system', 'global');
