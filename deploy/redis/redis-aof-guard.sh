#!/bin/sh
# M71: Redis AOF repair guard.
#
# Runs before redis-server to fix a torn AOF tail caused by abrupt shutdown
# (power loss, OOM-kill, docker kill). Redis 7+ uses a multi-part AOF layout
# (appendonlydir/appendonly.aof.manifest by default); older/custom layouts use
# a single AOF file. Override defaults with env vars if your redis.conf differs.
set -e

AOF_BASE_DIR="${REDIS_AOF_BASE_DIR:-/data}"
AOF_DIRNAME="${REDIS_AOF_DIRNAME:-appendonlydir}"
AOF_MANIFEST_NAME="${REDIS_AOF_MANIFEST:-appendonly.aof.manifest}"
AOF_DIR="$AOF_BASE_DIR/$AOF_DIRNAME"

repair_target() {
  target="$1"
  if [ -e "$target" ]; then
    echo "redis-aof-guard: checking $target"
    if printf 'y\n' | redis-check-aof --fix "$target" 2>&1; then
      echo "redis-aof-guard: $target is valid or repaired"
    else
      echo "redis-aof-guard: could not repair $target; continuing startup (Redis may still fail)" >&2
    fi
  fi
}

# Multi-part AOF (Redis 7+): manifest inside the configured appenddirname.
if [ -d "$AOF_DIR" ]; then
  MANIFEST="$AOF_DIR/$AOF_MANIFEST_NAME"
  if [ -f "$MANIFEST" ]; then
    repair_target "$MANIFEST"
  else
    # Fallback: any .manifest file in the directory.
    MANIFEST=$(find "$AOF_DIR" -maxdepth 1 -type f -name '*.manifest' -print -quit)
    if [ -n "$MANIFEST" ]; then
      repair_target "$MANIFEST"
    fi
  fi
fi

# Old-style single AOF file (pre-Redis 7 or custom appendfilename).
AOF_FILE_NAME="${REDIS_AOF_FILENAME:-appendonly.aof}"
AOF_FILE="$AOF_BASE_DIR/$AOF_FILE_NAME"
if [ -f "$AOF_FILE" ]; then
  repair_target "$AOF_FILE"
fi

exec redis-server "$@"
