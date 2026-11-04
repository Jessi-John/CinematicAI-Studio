# Runbook: Redis Loss / Degradation

Audience: operator on call. Redis is a single dependency shared by five
subsystems in this app. This page says what breaks, what the user sees, and
how to recover.

## What Redis holds

| Subsystem | Keys / usage | On Redis loss |
|---|---|---|
| Job queue (BullMQ) | `story-generation`, `story-generation-dlq`, `background-seo`, `background-embedding`, `background-dlq` | No new jobs run; in-flight jobs stall and are re-assigned or dead-lettered (see below) |
| Progress pub/sub + SSE buffer | `job:{id}:progress` channel, `sse:buffer:{jobId}` (200 events, 30min TTL) | SSE updates stop; buffer resume unavailable |
| Rate limiting | express-rate-limit counters (Redis store) | **Fail-open** — requests are served without limits (`rate-limit.redis-down.test.ts`) |
| JWT logout blacklist | `token_blacklist:{jti}` | **Fail-closed in production** — authenticated requests return 503 "Authentication service temporarily unavailable" (`middleware/jwt.ts`, MEDIUM #33). Dev/test fail-open |
| AI token budget | daily/monthly Lua counters, circuit-breaker state | **Fail-closed in production** — AI calls rejected with `budget_service_unavailable` (`services/token-budget.ts`). Dev/test use an in-memory fallback |
| Pipeline checkpoints | `job:{jobId}:attempt:{n}:stage:*:done`, `candidate:v1` (TTL 2h/4h) | Checkpoint resume unavailable; jobs restart from stage 1 on their next attempt (orchestrator CRITICAL #5) |

Also note: `maxmemory-policy allkeys-lru` means any of the above keys can be
evicted under memory pressure even when Redis is *up* — the checkpoint
recovery path treats an evicted candidate the same as a lost one.

## What the user sees

- Story generation stalls mid-progress; the frontend's SSE reconnect fails
  and it falls back to 5s HTTP polling (`hooks/use-generation.ts`), which
  keeps working while the API is up.
- Login/session still works for users whose token is not blacklisted, but in
  production every JWT-authenticated request 503s (blacklist check is on the
  hot path). Expect a burst of "Authentication service temporarily
  unavailable" errors.
- New generation POSTs fail with a budget/queue error rather than hanging.
- Health endpoint (`/api/health`) reports the redis dependency as down.

## Recovery steps

1. **Confirm the outage.** `docker compose ps redis`; hit
   `curl -s localhost:34567/api/health` and check the `redis` field.
2. **Restart Redis (AOF guard runs automatically).** The compose command wraps
   startup in `redis-aof-guard.sh` (M71), which repairs a torn AOF tail before
   `redis-server` starts — an unclean shutdown will not crash-loop Redis:
   `docker compose restart redis`
3. **Wait for clients to reconnect.** ioredis reconnects with backoff on its
   own; BullMQ workers resume pulling jobs without a manual restart. Watch
   worker logs for "Standalone story worker started"-level quiet, then
   resumed job activity.
4. **Expect stalled-job churn.** Jobs whose lock renewal lapsed while Redis
   was down are marked stalled by BullMQ and either retried on another
   worker attempt or moved to `story-generation-dlq` after 3 attempts.
   Checkpoint-fenced retries (H7) never resume from an orphaned attempt's
   stale candidate, and a missing candidate resets stage flags and reruns
   from stage 1 — the story completes from scratch, not corrupted.
5. **Verify.**
   - `docker compose exec redis redis-cli -a "$(docker compose exec redis sh -c 'cat /run/secrets/redis_password')" ping` → PONG
   - `/api/health` shows redis up
   - Queue depth: admin dashboard (or `GET /api/admin/queue` with the admin key) — restart any DLQ job users care about via
     `POST /api/admin/queue/:jobId/restart`
6. **If Redis will be down for a while.** Scale expectations, not workarounds:
   generation is effectively offline (budget fail-closed), browsing/editing
   also 503s in production (blacklist fail-closed). Communicate the outage;
   do not disable the fail-closed guards to "keep things working" — that is
   the documented unlimited-spend / logged-out-token-reuse footgun.

## Alerts

- Prometheus: RedisMemoryHigh (uses `redis_memory_max_bytes`, HIGH-3),
  redis down indicators. Loki: grep for
  "Token budget Redis failure in production" and
  "Authentication service temporarily unavailable" bursts.

## Related files

- `backend/src/middleware/rate-limit.ts` (fail-open store)
- `backend/src/middleware/jwt.ts` (blacklist fail-closed)
- `backend/src/services/token-budget.ts` (budget fail-closed, in-memory dev fallback)
- `backend/src/queue/redis-pubsub.ts` (progress events)
- `backend/src/routes/events.ts` (SSE buffer, 30min TTL)
- `backend/src/queue/workers/pipeline/orchestrator.ts` (checkpoints, H7/CRITICAL #5)
- `docker-compose.yml` redis service (AOF guard, maxmemory, secrets)
