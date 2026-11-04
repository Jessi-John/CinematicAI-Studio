#!/bin/sh
# docker-entrypoint.sh — Runtime config injection for Next.js frontend
#
# Writes the actual API_BASE_URL into public/runtime-config.js before
# starting the Next.js server. This makes the Docker image reusable
# across environments (dev, staging, production) without rebuilding.
#
# The server-side proxy (app/api/[...path]/route.ts) reads API_BASE_URL
# as its proxy target. The client-side runtime config uses
# NEXT_PUBLIC_API_URL — when empty (default), API calls go through the
# same-origin Next.js proxy (BFF mode), avoiding CORS.
#
# Usage (BFF mode — recommended):
#   docker run -e API_BASE_URL=http://backend:34567 my-app
#
# Usage (direct Express mode):
#   docker run -e API_BASE_URL=http://backend:34567 -e NEXT_PUBLIC_API_URL=http://localhost:34567 my-app

set -e

# LOW-17: API_BASE_URL is read by the Next.js server at runtime via
# process.env, not from this script. Only NEXT_PUBLIC_API_URL is written
# to the runtime config (used by browser-side code).
NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-}"

# M44 FIX: Use node + JSON.stringify to safely write the runtime config.
# Previous approach interpolated the raw env value into a JS string literal
# via heredoc — even with the shell-level validation for ' and \, any new
# special character (e.g. from a copy-paste URL) would break the generated
# JS. JSON.stringify handles all escaping automatically and guarantees valid
# output regardless of the input value.
if ! node -e "
const fs = require('fs');
const config = { API_BASE_URL: process.env.NEXT_PUBLIC_API_URL || '' };
const lines = [
  '// Runtime configuration — injected at container start by docker-entrypoint.sh',
  'window.__RUNTIME_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';',
  ''
];
fs.writeFileSync('/app/public/runtime-config.js', lines.join('\n'));
" 2>&1
then
  echo "FATAL: Failed to write /app/public/runtime-config.js — filesystem may be read-only" >&2
  exit 1
fi

# LOW #70: The Next.js middleware (Edge Runtime) needs JWT_SECRET to verify
# JWT signatures at the edge. Docker secrets are mounted at /run/secrets/*,
# but the Edge Runtime cannot read files, so we export it as an environment
# variable here. This is the only secret required by the frontend runtime.
if [ -f /run/secrets/jwt_secret ]; then
  export JWT_SECRET="$(cat /run/secrets/jwt_secret)"
fi

echo "docker-entrypoint: runtime config written — API_BASE_URL=${NEXT_PUBLIC_API_URL:-<empty (BFF mode)>}"

exec "$@"
