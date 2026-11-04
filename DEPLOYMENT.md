# Deployment Guide

## Production checklist

Before exposing the stack:

- [ ] `secrets/` contains fresh values from `bash scripts/generate-secrets.sh --write`, plus at least one AI provider key.
- [ ] `.env` sets `CADDY_HOST`, `DISABLE_REGISTRATION=true`, a strong `INVITE_CODE`, and the public `CORS_ORIGINS`.
- [ ] `ALLOW_INSECURE_LOCAL_HTTP` is false (the production override enforces this).
- [ ] Ports 80 and 443 are open; the backend is reachable only through Caddy.
- [ ] Backups are installed and a restore has been tested.
- [ ] `METRICS_ALLOWED_CIDRS` is narrowed if Prometheus has a fixed source address.
- [ ] Alerting (`ALERT_WEBHOOK_URL`) and log retention are configured.

## Backups

The scripts in `deploy/backup/` dump PostgreSQL and Redis, verify the dumps,
apply retention, and optionally upload to S3 with GPG or SSE-KMS encryption.
Install the scripts and `deploy/backup/cinematicai-backup.cron`; set
`PG_CONTAINER` and `REDIS_CONTAINER` in the cron file to the actual Compose
container names for your project, and set `ENV_FILE` to the deployment env file.
Test a restore before relying on the schedule.

## Database Migration Rollback Plan

### Automated protection (CI-enforced)

Every PR runs `scripts/test-migrations.mjs` in the `migration-test` CI job:
1. Spins up a fresh PostgreSQL instance
2. Runs `prisma migrate deploy` to apply ALL migrations
3. Runs `prisma migrate diff --exit-code` to verify zero schema drift
4. **If migrations don't match schema.prisma, the PR cannot merge**

This catches bad migrations (missing files, incorrect schemas, broken SQL)
before they ever reach production.

### Manual rollback procedure

Prisma does not support automatic rollback of migrations. If a bad migration
reaches production:

1. **Identify the bad migration**:
   ```bash
   cd backend/prisma/migrations/
   ls -la  # chronological order by timestamp prefix
   ```

2. **Roll back manually** — Prisma does not generate down migrations, so
   write reverse SQL manually:
   ```bash
   psql $DATABASE_URL -c "DROP TABLE IF EXISTS new_bad_table;"
   psql $DATABASE_URL -c "ALTER TABLE existing_table ADD COLUMN removed_column TEXT;"
   ```

3. **Mark the migration as rolled back**:
   ```bash
   cd backend
   npx prisma migrate resolve --rolled-back <migration_name>
   ```

4. **Verify schema is intact**:
   ```bash
   node scripts/test-migrations.mjs
   ```

### Irreversible migrations

Some migrations cannot be rolled back (column drops, table drops, data type
changes). Recovery procedure:
1. Restore from most recent backup (see `deploy/backup/backup-postgres.sh`)
2. Re-apply all migrations after the restore point
3. Verify data integrity with `node scripts/test-migrations.mjs`

### Prisma migrate vs db push

- Use `prisma migrate deploy` for production deployments
- NEVER use `prisma db push` in production — it silently drops the pgvector
  HNSW index defined in migration SQL, causing similarity queries to silently
  degrade to lexical fallback

## Horizontal Scaling

The ioredis DNS caching issue is fixed in
`backend/src/lib/create-redis.ts` by using `dnsLookup` with
`all: true + verbatim: true`, forcing fresh DNS resolution on every connection.
Static IPs have been removed from `docker-compose.yml`.

`docker compose up --scale` does not work with the default file because
`backend` and `worker` publish fixed host ports (`127.0.0.1:34567`, `3001`, and
`3002`); a second replica fails with a port conflict. Use a small override that
removes published ports, then put a load balancer in front and update the
worker metrics scrape configuration:

```yaml
# docker-compose.scale.yml
services:
  backend:
    ports: []
  worker:
    ports: []
```

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml \
  up -d --scale backend=3 --scale worker=5
```

For production Kubernetes/Docker Swarm deployments:
1. Use DNS-based service discovery (built-in for both orchestrators)
2. Add a load balancer (Caddy reverse proxy) in front of backend instances
3. Configure Prometheus with DNS-based target discovery instead of static
   scrape targets

## Version Strategy

This project follows **Semantic Versioning 2.0.0** with **Conventional Commits**,
enforced automatically at every level:

| Enforcement | Mechanism |
|-------------|-----------|
| Commit format | `commitlint` + husky `commit-msg` hook rejects non-conventional messages |
| PR gate | CI `commitlint` job runs on every PR |
| Version bump | `standard-version` runs on push to main via CI `release` workflow |
| Version sync | `scripts/sync-version.mjs` keeps root + backend `package.json` in lockstep |
| Git tag | CI auto-creates `vX.Y.Z` tag for every release |
| Changelog | `CHANGELOG.md` auto-generated from conventional commits |
| GitHub Release | CI creates a Release with auto-generated notes |

No manual step is required. To trigger a release, merge a PR with conventional
commits to `main`. The CI pipeline determines the next version automatically:
- `feat:` → MINOR bump
- `fix:` → PATCH bump  
- `BREAKING CHANGE:` → MAJOR bump
- `docs:/chore:/refactor:` → no release (skip)

## Redis AOF corruption recovery (M71)

An abrupt Redis stop (power loss, OOM-kill, `docker kill`) can leave a torn
tail in the append-only file. Symptom: Redis crash-loops with
`Bad file format reading the append only file appendonly.aof.*.incr.aof` and
the whole stack goes down.

Repair (verified during the audit):

```bash
docker compose stop redis
docker compose run --rm --entrypoint sh redis -c \
  'echo y | redis-check-aof --fix /data/appendonlydir/appendonly.aof.manifest'
docker compose up -d redis
```

This uses the Compose project's own container and volume names instead of a
hard-coded project directory. It truncates the torn bytes (typically a few
hundred bytes) and Redis starts cleanly. Consider periodic RDB snapshots
(`--save 60 1000`) as the fast recovery path for larger datasets.

The `redis` service command now runs an AOF repair guard
(`deploy/redis/redis-aof-guard.sh`) automatically before `redis-server` starts.
For most abrupt-stop scenarios the container will self-heal on the next boot
without operator intervention; the manual procedure above remains the fallback
for cases where the guard cannot fully repair the file or the guard itself has
been disabled.

## Docker Desktop (Windows/Mac) note: internal-network port mappings

`postgres` and `redis` run ONLY on the `internal: true` network. On Docker
Desktop (verified on Windows), host port publishing to such containers does
NOT forward (`127.0.0.1:6379` and `127.0.0.1:15432` are unreachable), while
on Linux Docker it works. For host-process development, use the full Docker
stack or native PostgreSQL/Redis. For one-off inspection, use
`docker compose exec` instead of host-mapped ports.

## Regeneration timeout scaling

The full-story regeneration wall-clock scales with `episodes_per_story`
(`getRegenerationTimeoutMs()` in `backend/src/services/story-regeneration.ts`,
floor 6 min, ~60s/episode + 2 min overhead). The route extends the request
socket timeout beyond it. Do not lower REQUEST_TIMEOUT_MS below the
regeneration budget or clients will see empty responses.
