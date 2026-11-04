#!/bin/sh
set -e

# -------------------------------------------------------------------------
# Migration init container entrypoint.
#
# Runs Prisma migrations as a one-shot job before the backend/worker start.
# This prevents multiple backend replicas from racing migrate deploy and
# keeps the prisma CLI out of the long-running backend process.
#
# SECURITY: Prisma CLI requires DATABASE_URL as an environment variable, so
# we read it from the Docker secret and export it ONLY inside this ephemeral
# init container. The secret does not propagate to the backend/worker.
# -------------------------------------------------------------------------

if [ ! -f /run/secrets/database_url ]; then
  echo "ERROR: database_url secret is required for migrations" >&2
  exit 1
fi

export DATABASE_URL="$(cat /run/secrets/database_url)"

PRISMA_BIN="/app/node_modules/.bin/prisma"

if [ -f "$PRISMA_BIN" ]; then
  "$PRISMA_BIN" migrate deploy
else
  PRISMA_VERSION="6.19.3"  # pinned — keep in sync with backend/package.json
  npx "prisma@${PRISMA_VERSION}" migrate deploy
fi
