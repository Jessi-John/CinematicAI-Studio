#!/usr/bin/env bash
# M34 + LOW #70: Generate cryptographically-random production secrets and write
# them as Docker secrets under secrets/. Run this once on a fresh clone, and
# again any time secrets need to be rotated.
#
# Usage:
#   bash scripts/generate-secrets.sh            # print generated secrets to stdout (safe default)
#   bash scripts/generate-secrets.sh --write    # write real secrets to secrets/ ONLY
#
# SECURITY: The default mode prints secrets to stdout and does NOT modify any
# files. Use --write only on a trusted local workstation; never commit the
# generated files. Prefer a real secret manager (HashiCorp Vault, AWS Secrets
# Manager, Azure Key Vault, 1Password) for production deployments.
#
# NOTE: This script intentionally does NOT write real secrets into .env.
# .env is a non-secret configuration template. Secrets are stored exclusively
# in secrets/ and mounted into containers via Docker secrets.

set -euo pipefail

WRITE_MODE=0
if [ "${1:-}" = "--write" ]; then
  WRITE_MODE=1
elif [ "${1:-}" = "--print" ]; then
  # L3a: --print is the documented default behavior — accept as a no-op alias.
  WRITE_MODE=0
elif [ -n "${1:-}" ]; then
  echo "Usage: $0 [--write|--print]" >&2
  echo "  (default: print-only)" >&2
  exit 1
fi

# L3b: umask BEFORE creating the directory (the immediate chmod made the
# race nearly harmless, but order matters).
umask 077

# L3c: anchor to repo root regardless of caller cwd.
cd "$(dirname "$0")/.."

# Ensure the Docker secrets directory exists with restrictive permissions.
mkdir -p secrets
chmod 700 secrets

# 32 random bytes = 64 hex chars = ~256 bits of entropy.
gen() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    echo "ERROR: no openssl and no /dev/urandom" >&2
    exit 1
  fi
}

POSTGRES_PASSWORD=$(gen)
REDIS_PASSWORD=$(gen)
API_SECRET=$(gen)
ADMIN_API_KEY=$(gen)
JWT_SECRET=$(gen)
GRAFANA_ADMIN_PASSWORD=$(gen)
ALERT_RECEIVER_TOKEN=$(gen)
LOKI_TENANT_ID=$(gen | cut -c1-32)

DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/cinematicai?schema=public"
REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379"

if [ "$WRITE_MODE" -eq 0 ]; then
  cat <<EOF
# Generated secrets (do not commit):
POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
REDIS_PASSWORD="$REDIS_PASSWORD"
API_SECRET="$API_SECRET"
ADMIN_API_KEY="$ADMIN_API_KEY"
JWT_SECRET="$JWT_SECRET"
DATABASE_URL="$DATABASE_URL"
REDIS_URL="$REDIS_URL"
GRAFANA_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD"
ALERT_RECEIVER_TOKEN="$ALERT_RECEIVER_TOKEN"
LOKI_TENANT_ID="$LOKI_TENANT_ID"
EOF
  exit 0
fi

# Ensure the Docker secrets directory exists with restrictive permissions.
mkdir -p secrets
chmod 700 secrets
umask 077

# Capture existing AI keys so they are preserved across runs.
read_existing() {
  local key=$1
  local file="secrets/$key"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo ""
  fi
}

MISTRAL_API_KEY=$(read_existing mistral_api_key)
KIMI_API_KEY=$(read_existing kimi_api_key)

# LOW #70: Write sensitive values to Docker secrets files so docker-compose.yml
# can mount them into containers instead of passing them as env vars.
write_secret() {
  local file=$1
  local value=$2
  printf '%s' "$value" > "secrets/$file"
  chmod 600 "secrets/$file"
}

write_secret database_url          "$DATABASE_URL"
write_secret redis_url             "$REDIS_URL"
write_secret api_secret            "$API_SECRET"
write_secret jwt_secret            "$JWT_SECRET"
write_secret admin_api_key         "$ADMIN_API_KEY"
write_secret postgres_password     "$POSTGRES_PASSWORD"
write_secret redis_password        "$REDIS_PASSWORD"
# L3d: preserved-but-empty AI keys must not be written as EMPTY files —
# downstream apps can't distinguish "unset" from "". Skip empties and say so.
if [ -n "$MISTRAL_API_KEY" ]; then write_secret mistral_api_key       "$MISTRAL_API_KEY"; else echo "note: mistral_api_key unset — skipping (not writing an empty secret)"; fi
if [ -n "$KIMI_API_KEY" ]; then write_secret kimi_api_key          "$KIMI_API_KEY"; else echo "note: kimi_api_key unset — skipping (not writing an empty secret)"; fi
write_secret grafana_admin_password.txt "$GRAFANA_ADMIN_PASSWORD"
write_secret alert_receiver_token  "$ALERT_RECEIVER_TOKEN"
write_secret loki_tenant_id        "$LOKI_TENANT_ID"

# Ensure the secrets directory itself is not world-accessible.
chmod 700 secrets

echo "M34: wrote fresh Docker secrets to secrets/"
echo "    - POSTGRES_PASSWORD, REDIS_PASSWORD, API_SECRET, ADMIN_API_KEY, JWT_SECRET"
echo "    - DATABASE_URL and REDIS_URL were rewritten to use the new passwords."
echo "    - GRAFANA_ADMIN_PASSWORD, ALERT_RECEIVER_TOKEN, and LOKI_TENANT_ID were generated."
echo "    - Each secret is 64 hex chars (256 bits of entropy)."
echo "    - LOKI_TENANT_ID is 32 hex chars (128 bits of entropy)."
echo "    - secrets/ permissions: 700; file permissions: 600."
echo "    - AI provider keys (MISTRAL_API_KEY, KIMI_API_KEY) were preserved —"
echo "      set them manually in secrets/mistral_api_key etc. before docker compose up."
echo "    - .env was NOT modified. Copy .env.example to .env and keep non-secret config there."
echo "    - ROTATE these values immediately if they were previously leaked or committed."
