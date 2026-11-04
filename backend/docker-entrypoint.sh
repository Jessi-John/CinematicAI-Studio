#!/bin/sh
set -e

# -------------------------------------------------------------------------
# Backend container entrypoint.
#
# SECURITY: This entrypoint does NOT export secrets as environment variables.
# Sensitive values are mounted as Docker secrets under /run/secrets/* and are
# read directly by the Node.js application (see src/config/env.ts). This
# prevents credentials from appearing in /proc/<pid>/environ.
#
# Database migrations are run by the dedicated `migrations` init container
# before the backend or worker containers start (see docker-compose.yml).
# -------------------------------------------------------------------------

exec "$@"
