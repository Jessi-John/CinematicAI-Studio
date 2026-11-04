#!/usr/bin/env bash
# M34: Daily PostgreSQL backup with 30-day retention, encryption, and
# restore verification.
#
# Run as a cron job. Installed by:
#   sudo cp deploy/backup/backup-postgres.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/backup-postgres.sh
#   echo "0 3 * * * root /usr/local/bin/backup-postgres.sh" | sudo tee /etc/cron.d/cinematicai-backup
#
# The script:
#   1. Runs pg_dump inside the postgres container (no host-side psql needed)
#   2. Compresses with gzip
#   3. Encrypts with GPG (optional) or uses S3 SSE-KMS
#   4. Verifies the backup with a test restore to a temporary container
#   5. Deletes backups older than $RETENTION_DAYS
#   6. Logs to syslog and to $BACKUP_DIR/backup.log

set -euo pipefail

# === Configuration ===
# Override these in /etc/cinematicai/backup.conf if needed.
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cinematicai/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
PG_CONTAINER="${PG_CONTAINER:-youtube-postgres-1}"
PGPASSWORD="${PGPASSWORD:-}"
LOG_FILE="${BACKUP_DIR}/backup.log"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-cinematicai-backups/postgres}"
BACKUP_GPG_PUBLIC_KEY="${BACKUP_GPG_PUBLIC_KEY:-}"
BACKUP_ALERT_WEBHOOK_URL="${BACKUP_ALERT_WEBHOOK_URL:-}"
ENV_FILE="${ENV_FILE:-/etc/cinematicai/.env}"

# H23: Source the env file so BACKUP_S3_BUCKET / BACKUP_GPG_PUBLIC_KEY /
# BACKUP_ALERT_WEBHOOK_URL configured there actually take effect — previously
# only passwords were extracted from it, so S3 uploads, GPG encryption, and
# failure alerts were silently unreachable via the documented deployment path.
# Explicit process env wins over file values (only UNSET vars are filled).
if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r k v; do
        case "$k" in ''|\#*) continue ;; esac
        v="${v%\"}"; v="${v#\"}"
        v="${v%\'}"; v="${v#\'}"
        v="${v%$'\r'}"
        case "$k" in
            BACKUP_S3_BUCKET) [ -z "$BACKUP_S3_BUCKET" ] && BACKUP_S3_BUCKET="$v" ;;
            BACKUP_S3_PREFIX) [ "$BACKUP_S3_PREFIX" = "cinematicai-backups/postgres" ] && [ -n "$v" ] && BACKUP_S3_PREFIX="$v" ;;
            BACKUP_GPG_PUBLIC_KEY) [ -z "$BACKUP_GPG_PUBLIC_KEY" ] && BACKUP_GPG_PUBLIC_KEY="$v" ;;
            BACKUP_ALERT_WEBHOOK_URL) [ -z "$BACKUP_ALERT_WEBHOOK_URL" ] && BACKUP_ALERT_WEBHOOK_URL="$v" ;;
            POSTGRES_PASSWORD) [ -z "$PGPASSWORD" ] && PGPASSWORD="$v" ;;
        esac
    done < "$ENV_FILE"
fi

# === Load PGPASSWORD if not already set ===
# Prefer the Docker secret file, then the environment, then a config file.
if [ -z "$PGPASSWORD" ] && [ -f /run/secrets/postgres_password ]; then
    PGPASSWORD="$(cat /run/secrets/postgres_password)"
fi
if [ -z "$PGPASSWORD" ] && [ -f "$ENV_FILE" ]; then
    if [ -z "$PGPASSWORD" ]; then
        DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r"' | tr -d "'")
        PGPASSWORD=$(printf '%s' "$DB_URL" | sed -n 's|^postgresql://[^:]*:\([^@]*\)@.*|\1|p')
    fi
fi
export PGPASSWORD

# === Helpers ===
# H23: mkdir BEFORE any log/fail call — previously a pre-flight failure called
# fail() before BACKUP_DIR existed, tee failed under pipefail, and the alert
# webhook never fired.
mkdir -p "$BACKUP_DIR" 2>/dev/null || true

log() {
    local msg="[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"
    echo "$msg" | tee -a "$LOG_FILE" 2>/dev/null || echo "$msg"
    command -v logger >/dev/null 2>&1 && logger -t cinematicai-backup "$*" || true
}

fail() {
    log "BACKUP FAILED: $*"
    if [ -n "$BACKUP_ALERT_WEBHOOK_URL" ]; then
        curl -fsS -X POST -H 'Content-Type: application/json' \
            -d "{\"text\":\"PostgreSQL backup failed: $*\"}" \
            "$BACKUP_ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
    fi
    exit 1
}

# H23: any UNANTICIPATED error (set -e) must still fire the failure alert —
# previously only explicitly-anticipated failures called fail().
trap 'rc=$?; if [ "$rc" -ne 0 ]; then fail "unexpected error (exit $rc) near line $LINENO"; fi' ERR

# === Temp-container cleanup ===
# The restore-verification container is tracked here so it is always removed,
# even when a later step calls fail() (which exits the script). Without this,
# a failed verification would leak a running postgres container every night.
VERIFY_CONTAINER=""
cleanup_verify_container() {
    if [ -n "$VERIFY_CONTAINER" ]; then
        docker rm -f "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
        VERIFY_CONTAINER=""
    fi
}
trap cleanup_verify_container EXIT

# === Pre-flight ===
if ! command -v docker >/dev/null 2>&1; then
    fail "docker is not installed or not in PATH"
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    fail "container ${PG_CONTAINER} is not running"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# === Backup ===
TIMESTAMP=$(date -u +'%Y%m%dT%H%M%SZ')
BACKUP_FILE="${BACKUP_DIR}/cinematicai-${TIMESTAMP}.sql.gz"

log "starting backup to ${BACKUP_FILE}"

# H23: don't pass the password as a CLI arg (visible in the host process
# list) — read it inside the container from the Docker secret file (the
# postgres container mounts POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password).
if ! docker exec "$PG_CONTAINER" sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_dump --no-owner --no-privileges --dbname=cinematicai --username=postgres' | gzip -9 > "$BACKUP_FILE"; then
    rm -f "$BACKUP_FILE"
    fail "pg_dump failed"
fi

# === Verify ===
if [ ! -s "$BACKUP_FILE" ]; then
    fail "backup file is empty"
fi

if ! gunzip -t "$BACKUP_FILE" 2>/dev/null; then
    fail "backup file is not a valid gzip"
fi

# Check the dump actually looks like pg_dump output. `head` closes the pipe
# early, which under `set -o pipefail` would make gunzip's SIGPIPE (141) fail
# the check even for a valid dump. Capture the header first (swallowing the
# SIGPIPE), then grep it separately so a valid dump is never rejected.
dump_head="$(gunzip -c "$BACKUP_FILE" 2>/dev/null | head -10 || true)"
if ! grep -q "PostgreSQL database dump" <<< "$dump_head"; then
    fail "backup does not look like a valid pg_dump output"
fi

BACKUP_SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo 0)
log "backup complete: ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"

# === Restore verification ===
verify_restore() {
    log "starting restore verification"
    local verify_container="cinematicai-pg-verify-${TIMESTAMP}"
    local verify_db="cinematicai_verify"
    local verify_network
    verify_network=$(docker inspect "$PG_CONTAINER" --format '{{range $n, $_ := .NetworkSettings.Networks}}{{print $n}}{{end}}' | head -n1)
    [ -z "$verify_network" ] && verify_network="bridge"

    # Use the SAME image as the running postgres container so the restore
    # target matches the source server version (version parity).
    local pg_image
    pg_image=$(docker inspect "$PG_CONTAINER" --format '{{.Config.Image}}')
    if [ -z "$pg_image" ]; then
        fail "restore verification: could not determine postgres image from ${PG_CONTAINER}"
    fi

    # Start a REAL temporary postgres server. Do NOT override the entrypoint:
    # the stock postgres entrypoint is what initializes and starts the server.
    # (The previous approach overrode it with `bash -c "... pg_isready ..."`,
    # so no server ever started and verification could never pass.) A tmpfs
    # data dir gives the temp server a clean, disposable data directory.
    if ! docker run -d --name "$verify_container" \
            --network "$verify_network" \
            -e POSTGRES_PASSWORD=verify \
            --tmpfs /var/lib/postgresql/data \
            "$pg_image" >/dev/null 2>&1; then
        fail "restore verification: failed to start temp postgres container"
    fi
    # Register for guaranteed cleanup on any exit path (success or fail()).
    VERIFY_CONTAINER="$verify_container"

    # Wait for the temp server to accept connections (up to ~60s).
    local ready=0
    for _ in $(seq 1 60); do
        if docker exec "$verify_container" pg_isready -U postgres >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done
    if [ "$ready" -ne 1 ]; then
        fail "restore verification: temp postgres did not become ready"
    fi

    # Create the target database.
    if ! docker exec -e PGPASSWORD=verify "$verify_container" \
            psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
            -c "CREATE DATABASE ${verify_db};" >/dev/null 2>&1; then
        fail "restore verification: failed to create temp database"
    fi

    # Stream the dump into the temp server. ON_ERROR_STOP=1 makes any SQL error
    # abort the restore with a non-zero status, so a corrupt dump fails here.
    if ! gunzip -c "$BACKUP_FILE" | docker exec -i -e PGPASSWORD=verify "$verify_container" \
            psql -U postgres -d "$verify_db" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
        fail "restore verification: dump failed to restore cleanly"
    fi

    # Sanity check: the restored database must contain at least one table.
    local table_count
    table_count=$(docker exec -e PGPASSWORD=verify "$verify_container" \
        psql -U postgres -d "$verify_db" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)
    if [ "${table_count:-0}" -lt 1 ]; then
        fail "restore verification: restored database has no tables"
    fi

    log "restore verification succeeded (${table_count} tables)"
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
        S3_KEY="${BACKUP_S3_PREFIX}/postgres-$(basename "$UPLOAD_FILE")"
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
DELETED_COUNT=$(find "$BACKUP_DIR" -name "cinematicai-*.sql.gz*" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
if [ "$DELETED_COUNT" -gt 0 ]; then
    log "retention: deleted $DELETED_COUNT backup(s) older than ${RETENTION_DAYS} days"
fi

log "backup cycle complete"

# === Restore instructions ===
# To restore from a backup:
#   gunzip -c /var/backups/cinematicai/postgres/cinematicai-XXX.sql.gz \
#     | docker exec -i youtube-postgres-1 psql -U postgres -d cinematicai
#
# Note: this will OVERWRITE existing data. Stop the backend and worker
# before restoring to avoid write conflicts:
#   docker compose stop backend worker
#   # ...restore...
#   docker compose start backend worker
