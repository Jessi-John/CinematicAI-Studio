# Deployment Guide

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

`docker compose up --scale` is now supported. The ioredis DNS caching issue
was fixed in `lib/create-redis.ts` by using `dnsLookup` with `all: true +
verbatim: true`, forcing fresh DNS resolution on every connection. Static IPs
have been removed from docker-compose.yml.

### To scale horizontally:

```bash
docker compose up --scale backend=3 --scale worker=5 -d
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
docker stop youtube-redis-1
docker run --rm -v youtube_redis_data:/data redis:7-alpine sh -c \
  'echo y | redis-check-aof --fix /data/appendonlydir/appendonly.aof.manifest'
docker compose up -d redis
```

This truncates the torn bytes (typically a few hundred bytes) and Redis starts
cleanly. Consider periodic RDB snapshots (`--save 60 1000`) as the fast
recovery path for larger datasets.

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
on Linux Docker it works. Dev workflows that need direct host access should
use `docker exec` instead of host-mapped ports.

## Regeneration timeout scaling

The full-story regeneration wall-clock scales with `episodes_per_story`
(`getRegenerationTimeoutMs()` in `backend/src/services/story-regeneration.ts`,
floor 6 min, ~60s/episode + 2 min overhead). The route extends the request
socket timeout beyond it. Do not lower REQUEST_TIMEOUT_MS below the
regeneration budget or clients will see empty responses.
