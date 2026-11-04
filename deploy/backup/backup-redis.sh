#!/usr/bin/env bash
# Redis backup with 30-day retention, encryption, and restore verification.
#
# Run as a cron job alongside backup-postgres.sh:
#   sudo cp deploy/backup/backup-redis.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/backup-redis.sh
#
# The script:
#   1. Runs redis-cli --rdb inside the redis container
#   2. Compresses with gzip
#   3. Encrypts with GPG (optional) or uses S3 SSE-KMS
#   4. Verifies the backup with a test restore to a temporary container
#   5. Deletes backups older than $RETENTION_DAYS
#   6. Optionally uploads to S3 if BACKUP_S3_BUCKET is set

set -euo pipefail

# === Configuration ===
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cinematicai/redis}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
REDIS_CONTAINER="${REDIS_CONTAINER:-youtube-redis-1}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
LOG_FILE="${BACKUP_DIR}/backup.log"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-cinematicai-backups/redis}"
BACKUP_GPG_PUBLIC_KEY="${BACKUP_GPG_PUBLIC_KEY:-}"
BACKUP_ALERT_WEBHOOK_URL="${BACKUP_ALERT_WEBHOOK_URL:-}"
ENV_FILE="${ENV_FILE:-/etc/cinematicai/.env}"

# H23: source the env file so BACKUP_S3_BUCKET / BACKUP_GPG_PUBLIC_KEY /
# BACKUP_ALERT_WEBHOOK_URL configured there take effect (see backup-postgres.sh).
if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r k v; do
        case "$k" in ''|\#*) continue ;; esac
        v="${v%\"}"; v="${v#\"}"
        v="${v%\'}"; v="${v#\'}"
        v="${v%$'\r'}"
        case "$k" in
            BACKUP_S3_BUCKET) [ -z "$BACKUP_S3_BUCKET" ] && BACKUP_S3_BUCKET="$v" ;;
            BACKUP_S3_PREFIX) [ "$BACKUP_S3_PREFIX" = "cinematicai-backups/redis" ] && [ -n "$v" ] && BACKUP_S3_PREFIX="$v" ;;
            BACKUP_GPG_PUBLIC_KEY) [ -z "$BACKUP_GPG_PUBLIC_KEY" ] && BACKUP_GPG_PUBLIC_KEY="$v" ;;
            BACKUP_ALERT_WEBHOOK_URL) [ -z "$BACKUP_ALERT_WEBHOOK_URL" ] && BACKUP_ALERT_WEBHOOK_URL="$v" ;;
            REDIS_PASSWORD) [ -z "$REDIS_PASSWORD" ] && REDIS_PASSWORD="$v" ;;
        esac
    done < "$ENV_FILE"
fi

# === Load REDIS_PASSWORD if not already set ===
if [ -z "$REDIS_PASSWORD" ] && [ -f /run/secrets/redis_password ]; then
    REDIS_PASSWORD="$(cat /run/secrets/redis_password)"
fi
export REDIS_PASSWORD

# === Helpers ===
# H23: mkdir BEFORE any log/fail call (see backup-postgres.sh).
mkdir -p "$BACKUP_DIR" 2>/dev/null || true

log() {
    local msg="[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"
    echo "$msg" | tee -a "$LOG_FILE" 2>/dev/null || echo "$msg"
    command -v logger >/dev/null 2>&1 && logger -t cinematicai-redis-backup "$*" || true
}

fail() {
    log "BACKUP FAILED: $*"
    if [ -n "$BACKUP_ALERT_WEBHOOK_URL" ]; then
        curl -fsS -X POST -H 'Content-Type: application/json' \
            -d "{\"text\":\"Redis backup failed: $*\"}" \
            "$BACKUP_ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
    fi
    exit 1
}

# H23: any UNANTICIPATED error (set -e) must still fire the failure alert.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then fail "unexpected error (exit $rc) near line $LINENO"; fi' ERR

# === Pre-flight ===
if ! command -v docker >/dev/null 2>&1; then
    fail "docker is not installed or not in PATH"
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${REDIS_CONTAINER}$"; then
    fail "container ${REDIS_CONTAINER} is not running"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# === Backup ===
TIMESTAMP=$(date -u +'%Y%m%dT%H%M%SZ')
BACKUP_FILE="${BACKUP_DIR}/redis-${TIMESTAMP}.rdb.gz"
# Path INSIDE the redis container (redis-cli runs there via docker exec).
TMP_RDB="/tmp/redis-${TIMESTAMP}.rdb"
# Path on the HOST where the dump is copied before compression.
HOST_TMP_RDB="${BACKUP_DIR}/.redis-dump-${TIMESTAMP}.rdb"

log "starting backup to ${BACKUP_FILE}"

# Generate the RDB snapshot inside the container.
# H23: read the password INSIDE the container from the Docker secret file
# instead of passing it as a CLI arg (visible in the host process list).
if ! docker exec "$REDIS_CONTAINER" sh -c "REDISCLI_AUTH=\"\$(cat /run/secrets/redis_password 2>/dev/null || true)\" redis-cli --rdb '$TMP_RDB'"; then
    docker exec "$REDIS_CONTAINER" rm -f "$TMP_RDB" >/dev/null 2>&1 || true
    fail "redis-cli --rdb failed"
fi

# Copy the dump OUT of the container to the host before compressing.
# Previously gzip ran on the host against "$TMP_RDB", a path that only existed
# inside the container, so the compression step always failed.
if ! docker cp "$REDIS_CONTAINER:$TMP_RDB" "$HOST_TMP_RDB"; then
    docker exec "$REDIS_CONTAINER" rm -f "$TMP_RDB" >/dev/null 2>&1 || true
    fail "failed to copy RDB dump out of container ${REDIS_CONTAINER}"
fi
# Remove the in-container copy now that it is safely on the host.
docker exec "$REDIS_CONTAINER" rm -f "$TMP_RDB" >/dev/null 2>&1 || true

if ! gzip -9 -c "$HOST_TMP_RDB" > "$BACKUP_FILE"; then
    rm -f "$HOST_TMP_RDB" "$BACKUP_FILE"
    fail "gzip compression failed"
fi
rm -f "$HOST_TMP_RDB"

# === Verify ===
if [ ! -s "$BACKUP_FILE" ]; then
    fail "backup file is empty"
fi

if ! gunzip -t "$BACKUP_FILE" 2>/dev/null; then
    fail "backup file is not a valid gzip"
fi

BACKUP_SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo 0)
log "backup complete: ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"

# === Restore verification ===
verify_restore() {
    log "starting restore verification"
    local verify_container="cinematicai-redis-verify-${TIMESTAMP}"
    # L9a: verify against the SAME image the production container runs, not a
    # separately pinned digest that can drift from production.
    local verify_image
    verify_image=$(docker inspect --format '{{.Config.Image}}' "$REDIS_CONTAINER" 2>/dev/null || echo 'redis:7-alpine')
    # L9a: poll redis-cli ping with a timeout instead of a fixed sleep — RDB
    # loading of large datasets exceeds 1s and would falsely fail verification.
    if ! docker run --rm --name "$verify_container" \
            -v "$BACKUP_FILE:/tmp/backup.rdb.gz:ro" \
            "$verify_image" \
            sh -c "set -e; gunzip -c /tmp/backup.rdb.gz > /data/dump.rdb; redis-server --daemonize yes --requirepass verify; for i in \$(seq 1 30); do redis-cli -a verify ping 2>/dev/null | grep -q PONG && exit 0; sleep 1; done; echo 'verify server did not become ready' >&2; exit 1" 2>/dev/null; then
        fail "restore verification failed"
    fi
    log "restore verification succeeded"
}

verify_restore

# === Optional encryption + S3 upload ===
UPLOAD_FILE="$BACKUP_FILE"
if [ -n "$BACKUP_GPG_PUBLIC_KEY" ]; then
    ENCRYPTED_FILE="${BACKUP_FILE}.gpg"
    if command -v gpg >/dev/null 2>&1; then
        if gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_PUBLIC_KEY" --encrypt --output "$ENCRYPTED_FILE" "$BACKUP_FILE"; then
            rm -f "$BACKUP_FILE"
            UPLOAD_FILE="$ENCRYPTED_FILE"
            log "backup encrypted with GPG: ${ENCRYPTED_FILE}"
        else
            fail "GPG encryption failed"
        fi
    else
        fail "BACKUP_GPG_PUBLIC_KEY is set but gpg is not installed"
    fi
fi

if [ -n "$BACKUP_S3_BUCKET" ]; then
    if command -v aws >/dev/null 2>&1; then
        S3_KEY="${BACKUP_S3_PREFIX}/redis-$(basename "$UPLOAD_FILE")"
        if aws s3 cp "$UPLOAD_FILE" "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" --sse aws:kms; then
            log "uploaded backup to s3://${BACKUP_S3_BUCKET}/${S3_KEY}"
        else
            fail "S3 upload failed"
        fi
    else
        log "WARNING: BACKUP_S3_BUCKET is set but aws CLI is not installed; skipping S3 upload"
    fi
fi

# === Retention ===
DELETED_COUNT=$(find "$BACKUP_DIR" -name "redis-*.rdb.gz*" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
if [ "$DELETED_COUNT" -gt 0 ]; then
    log "retention: deleted $DELETED_COUNT backup(s) older than ${RETENTION_DAYS} days"
fi

log "backup cycle complete"

# === Restore instructions ===
# To restore from a backup:
#   docker compose stop backend worker
#   gunzip -c /var/backups/cinematicai/redis/redis-XXX.rdb.gz > /tmp/dump.rdb
#   docker cp /tmp/dump.rdb youtube-redis-1:/data/dump.rdb
#   docker compose restart redis
#   docker compose start backend worker
