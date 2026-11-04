# CinematicAI Studio

CinematicAI Studio is a self-hosted web application for generating original,
hand-painted storybook-anime story arcs for short-form video. It turns a genre,
seed, and theme into a complete story package: characters, world settings,
episodes, scene-by-scene visual prompts, narration, and YouTube metadata.

The application is a Next.js frontend backed by an Express API, PostgreSQL with
pgvector, Redis, and a BullMQ worker. Story generation runs asynchronously and
streams progress to the browser with Server-Sent Events (SSE).

> **Project status:** active development. The repository contains a working
> application, automated tests, CI, and deployment configuration. It is
> distributed under the [MIT license](#license).

## Contents

- [Why this project exists](#why-this-project-exists)
- [Key features](#key-features)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Running the frontend and backend](#running-the-frontend-and-backend)
- [Docker deployment](#docker-deployment)
- [Testing](#testing)
- [API documentation](#api-documentation)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Why this project exists

Producing a serialized anime short-form series requires more than a single
prompt. A creator needs consistent characters, a coherent world, episode and
scene structure, repeatable visual direction, narration timing, and metadata
that gives each video a chance to be discovered.

CinematicAI Studio addresses that by treating a story as a structured data
model rather than a chat transcript:

- Character and world bibles are generated first and reused across every scene.
- Episodes and scenes are persisted with stable identifiers and versions.
- Regeneration is scoped to one episode or scene, with continuity context and
  optimistic locking.
- Quality, humanization, similarity, and copyright checks run as part of the
  pipeline.
- Generation is queued, observable, and retryable instead of blocking a web
  request.

## Key features

- **Structured story generation** — character bible, world bible, 10 episodes,
  5 scenes per episode, and SEO metadata.
- **Continuity-aware scene prompts** — character and environment state is
  carried into image and video prompts.
- **Asynchronous pipeline** — BullMQ jobs with progress events over SSE and an
  HTTP polling fallback.
- **Selective regeneration** — regenerate a single episode or scene, or replace
  a story atomically.
- **Quality controls** — quality scoring, humanization, similarity detection,
  copyright filtering, and configurable quality floors.
- **Story library** — paginated history, search, filtering, and export to
  JSON, CSV, TXT, SSML, SRT, and VTT.
- **Authentication and administration** — JWT cookie sessions, CSRF protection,
  admin-only settings and queue management, optional invite-only registration.
- **Operational tooling** — health endpoints, Prometheus metrics, structured
  logs, dead-letter queue recovery, and Docker Compose stacks for local and
  production use.

## Technology stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, TanStack Query, Zustand, Tailwind CSS 4, Framer Motion |
| Backend | Node.js 20+, Express 4, TypeScript, Zod |
| Background jobs | BullMQ with Redis |
| Data | PostgreSQL 16 with pgvector, Prisma ORM |
| AI providers | Mistral (primary), Kimi K3 (fallback) |
| Observability | Pino, Prometheus, OpenTelemetry, Jaeger, Grafana, Loki |
| Deployment | Docker, Docker Compose, Caddy (production TLS) |
| Testing | Vitest (frontend and backend), Playwright (end-to-end) |

Package versions are pinned in the root `package.json`,
`backend/package.json`, and their lockfiles.

## Architecture

```text
Browser
  │
  ▼
Next.js frontend :3000
  │  same-origin /api/* proxy (BFF)
  ▼
Express API :34567 ──────────────► PostgreSQL 16 + pgvector
  │        │                              ▲
  │        └── SSE progress (Redis)       │
  ▼                                       │
Redis 7 (queue, pub/sub, rate limits)     │
  │                                       │
  ▼                                       │
BullMQ worker ──── AI providers ──────────┘
```

| Component | Port | Responsibility |
| --- | --- | --- |
| `frontend` | 3000 | Next.js UI and server-side BFF proxy |
| `backend` | 34567 | Express REST API, SSE, auth, exports |
| `worker` | 3001 (health), 3002 (metrics) | BullMQ story-generation pipeline |
| `postgres` | 5432 (host: 15432 in the dev stack) | Primary database and vector search |
| `redis` | 6379 | Queue, pub/sub, rate limiting, token budgets |

### Generation pipeline

```text
POST /api/stories/generate
  → BullMQ job
  → budget + uniqueness preflight
  → blueprint
  → character bible
  → world bible
  → episodes and scenes
  → humanization
  → quality scoring (with bounded refinement)
  → SEO
  → copyright sweep
  → embedding
  → persistence
  → SSE "complete" event
```

The data model is `Story → Episode → Scene`, with related `Character`,
`Environment`, `YouTubeSEO`, and `GenerationLog` records. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for detailed diagrams and request flows,
and `backend/prisma/schema.prisma` for the canonical schema.

## Screenshots

This repository does not currently include application screenshots. To add
them, place images under `docs/images/` and link them here. Do not use
screenshots that contain real credentials, user data, or API keys.

## Installation

### Prerequisites

- Node.js 20 or newer (the backend declares `node >=20`)
- npm (the repository uses `package-lock.json`)
- Docker with Docker Compose v2 for the containerized setup
- At least one AI provider key: `MISTRAL_API_KEY` or `KIMI_API_KEY`
- Git

### Docker quick start

The development Compose stack reads sensitive values from files in `secrets/`,
not from `docker-compose.yml`.

```bash
git clone https://github.com/Jessi-John/CinematicAI-Studio.git
cd CinematicAI-Studio

cp .env.example .env
bash scripts/generate-secrets.sh --write

# Add at least one AI provider key. Do not add a trailing newline.
printf '%s' 'your-mistral-api-key' > secrets/mistral_api_key
# or: printf '%s' 'your-kimi-api-key' > secrets/kimi_api_key

docker compose up -d
curl http://localhost:34567/api/health
```

Open <http://localhost:3000> and register an account at `/register`.

On Windows, run `scripts/generate-secrets.sh` from Git Bash or WSL. If you use
PowerShell, write the secret files without a trailing newline:

```powershell
Set-Content -NoNewline -Path secrets/mistral_api_key -Value 'your-mistral-api-key'
```

To stop the stack:

```bash
docker compose down
```

To remove local data volumes as well:

```bash
docker compose down -v
```

## Local development

Local development uses the Compose stack for PostgreSQL and Redis and runs the
frontend and backend as Node.js processes.

### 1. Start infrastructure

```bash
cp .env.example .env
bash scripts/generate-secrets.sh --write
docker compose up -d postgres redis
```

The development stack publishes PostgreSQL on `127.0.0.1:15432` and Redis on
`127.0.0.1:6379` when host port forwarding is available. On Docker Desktop for
Windows and macOS, host port mappings to services on the internal network are
not reachable (verified on Windows); use the full Docker stack or native
PostgreSQL/Redis for host-process development. See
[`DEPLOYMENT.md`](DEPLOYMENT.md).

### 2. Configure and start the backend

```bash
cd backend
cp .env.example .env
```

Set these values in `backend/.env`:

```dotenv
DATABASE_URL=postgresql://postgres:<POSTGRES_PASSWORD>@localhost:15432/cinematicai?schema=public
REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379
MISTRAL_API_KEY=your-mistral-api-key
JWT_SECRET=<64-hex-value-shared-with-the-frontend>
NODE_ENV=development
PORT=34567
```

`<POSTGRES_PASSWORD>` and `<REDIS_PASSWORD>` are the values generated in
`secrets/postgres_password` and `secrets/redis_password`. Generate a JWT secret
once with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and
use the same value in the frontend `.env.local`; otherwise the frontend cannot
verify backend-issued session cookies. A host-run backend with
`NODE_ENV=development` does not need `ALLOW_INSECURE_LOCAL_HTTP`; the Docker
stack sets that flag because it runs with `NODE_ENV=production`.

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev
```

`backend/.env.example` sets `RUN_WORKER_INPROCESS=true`, so `npm run dev` starts
the API and an in-process worker. For process isolation, set
`RUN_WORKER_INPROCESS=false` and start the worker separately:

```bash
cd backend
npm run worker
```

### 3. Configure and start the frontend

From the repository root, create `.env.local`:

```dotenv
API_BASE_URL=http://localhost:34567
JWT_SECRET=<same 64-hex value used in backend/.env>
```

`API_BASE_URL` is required by the Next.js server-side proxy. `JWT_SECRET` must
match the backend value because the frontend proxy (`proxy.ts`) verifies session
cookies at the edge. Do not put server secrets in `NEXT_PUBLIC_*` variables;
those are exposed to the browser.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>.

### 4. Create an account and an administrator

Register at <http://localhost:3000/register>. With
`DISABLE_REGISTRATION=true`, registration requires the configured
`INVITE_CODE`. When registration is open, the first user is a normal user
unless `BOOTSTRAP_FIRST_USER_ADMIN=true` is set. To promote a user manually:

```bash
cd backend
npx prisma studio
```

Set the `User.role` column to `admin`. Admin routes accept an admin JWT or the
`ADMIN_API_KEY` bearer token.

## Environment variables

The templates are [`/.env.example`](.env.example) (Docker Compose
non-secret settings) and [`backend/.env.example`](backend/.env.example)
(host-run backend). The table below lists the variables most operators need;
the full validated set is in
[`backend/src/config/env.ts`](backend/src/config/env.ts).

### Backend

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string, including the password |
| `REDIS_PASSWORD` | Production | — | Redis password when it is not embedded in `REDIS_URL` |
| `API_SECRET` | Production; optional in local dev | random per process in development | HMAC key for signed SSE URLs |
| `ADMIN_API_KEY` | Production; only for API-key admin access | random per process in development | Server-to-server admin authentication |
| `JWT_SECRET` | Production; required when the frontend runs separately | derived per process when unset | JWT signing and verification key; must match the frontend proxy |
| `MISTRAL_API_KEY` | One provider | — | Mistral key; primary story-generation and embedding provider |
| `KIMI_API_KEY` | One provider | — | Kimi key; fallback story-generation provider |
| `MISTRAL_BASE_URL` | No | `https://api.mistral.ai/v1` | Mistral-compatible endpoint |
| `MISTRAL_MODEL` | No | `mistral-medium-2508` | Mistral model |
| `KIMI_BASE_URL` | No | `https://api.kimi.com/coding/v1/chat/completions` | Kimi-compatible endpoint |
| `KIMI_MODEL` | No | `k3` | Kimi model |
| `PORT` | No | `34567` | API port |
| `CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed browser origins |
| `RUN_WORKER_INPROCESS` | No | `false` | Run the worker in the API process (development convenience) |
| `WORKER_CONCURRENCY` | No | `2` | Concurrent story jobs per worker |
| `DISABLE_REGISTRATION` | Production recommended | `false` | Reject open signup |
| `INVITE_CODE` | With invite-only mode | — | Registration code when signup is disabled |
| `BOOTSTRAP_FIRST_USER_ADMIN` | No | `false` | Promote the first open-registration user to admin |
| `ALLOW_INSECURE_LOCAL_HTTP` | No | `false` | Allow cookie/CSRF auth over plain HTTP for local Docker/development only |
| `MAX_CONCURRENT_GENERATIONS` | No | `0` (unlimited) | Global concurrency cap |
| `MAX_STORIES_PER_DAY` | No | `0` (unlimited) | Daily story cap |
| `AI_DAILY_SPEND_CAP_USD` | No | `0` (unlimited) | Daily AI spend cap |
| `AI_MONTHLY_SPEND_CAP_USD` | No | `0` (unlimited) | Monthly AI spend cap |
| `AI_DAILY_TOKEN_BUDGET` | No | `0` (unlimited) | Daily token budget |
| `AI_MONTHLY_TOKEN_BUDGET` | No | `0` (unlimited) | Monthly token budget |
| `METRICS_ALLOWED_CIDRS` | No | loopback + RFC1918 ranges | Comma-separated CIDRs allowed to scrape `/metrics` |

### Frontend

| Variable | Required | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | Yes for the server-side proxy | Backend URL used by the Next.js BFF and server-side code |
| `NEXT_PUBLIC_API_URL` | No | Direct browser-to-backend URL; leave empty to use the same-origin proxy |
| `JWT_SECRET` | Yes when sessions are used | Must match the backend JWT secret |

### Docker secrets

The Compose stack mounts these files from `secrets/`:

- `database_url`
- `redis_url`
- `api_secret`
- `jwt_secret`
- `admin_api_key`
- `postgres_password`
- `redis_password`
- `mistral_api_key` (optional)
- `kimi_api_key` (optional)
- `grafana_admin_password.txt`
- `alert_receiver_token`
- `loki_tenant_id`

Generate the non-AI values with `bash scripts/generate-secrets.sh --write`.
The `secrets/` directory is ignored by Git and must never be committed.

## Running the frontend and backend

| Command | Location | Description |
| --- | --- | --- |
| `npm run dev` | root | Next.js development server on port 3000 |
| `npm run build` | root | Production Next.js build |
| `npm start` | root | Serve the production Next.js build |
| `npm run lint` | root | ESLint for the frontend |
| `npm run typecheck` | root | TypeScript check for application code |
| `npm run typecheck:all` | root | TypeScript check including test files |
| `npm test` | root | Frontend tests, then backend tests |
| `npm run test:backend` | root | Backend tests only |
| `npm run dev` | `backend/` | Express API with `tsx watch` |
| `npm run build` | `backend/` | Compile TypeScript to `backend/dist/` |
| `npm start` | `backend/` | Run the compiled API |
| `npm run worker` | `backend/` | Run a standalone BullMQ worker |
| `npm run lint` | `backend/` | ESLint for the backend |
| `npm run typecheck` | `backend/` | TypeScript check for backend source |
| `npm run typecheck:all` | `backend/` | TypeScript check including backend tests |
| `npm test` | `backend/` | Backend Vitest suite |
| `npm run test:coverage` | `backend/` | Backend tests with coverage |
| `npm run db:generate` | `backend/` | Generate the Prisma client |
| `npm run db:migrate` | `backend/` | Create and apply a development migration |
| `npm run db:deploy` | `backend/` | Apply committed migrations |
| `npm run db:studio` | `backend/` | Open Prisma Studio |

## Docker deployment

### Development stack

Before the first start, create the non-secret Compose configuration and the
secret files:

```bash
cp .env.example .env
bash scripts/generate-secrets.sh --write
```

Then start the stack:

```bash
docker compose up -d --build
```

This starts PostgreSQL, Redis, migrations, the API, the worker, the frontend,
and the observability services. The frontend is at port 3000 and the API is at
port 34567.

### Production stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Before starting production:

- Generate fresh secrets and place them in `secrets/`; do not reuse local values.
- Set `CADDY_HOST` to the public domain.
- Set `DISABLE_REGISTRATION=true` and a strong `INVITE_CODE` unless open signup
  is intentional.
- The production override forces `ALLOW_INSECURE_LOCAL_HTTP=false`; do not
  re-enable it.
- Set real AI provider keys in `secrets/mistral_api_key` and/or
  `secrets/kimi_api_key`.
- Configure backups and review the production checklist in
  [`DEPLOYMENT.md`](DEPLOYMENT.md).

The production override adds a Caddy TLS reverse proxy and removes development
volume mounts. See `deploy/caddy/Caddyfile` for the proxy configuration.

### Health checks

```bash
curl http://localhost:34567/api/health
```

The backend reports database and Redis status. The worker exposes
`http://localhost:3001/health`, and Prometheus metrics are available on the
worker metrics port and at the backend `/metrics` endpoint.

## Testing

### Unit and integration tests

```bash
# Everything (frontend + backend)
npm test

# Frontend only
npx vitest run

# Backend only
cd backend && npm test

# Backend with coverage
cd backend && npm run test:coverage
```

### End-to-end tests

The E2E suite uses Playwright and expects the Docker stack to be running. The
`test:e2e` script starts the stack with the E2E override, waits for health
checks, and runs the browser tests.

```bash
npm run test:e2e
```

The E2E override sets `E2E_TEST=true`, `STORY_TEST_MODE=canned`, and
`ALLOW_E2E_IN_PRODUCTION=true`. `E2E_TEST` bypasses auth/CSRF/rate limits,
`STORY_TEST_MODE` replaces AI calls with deterministic canned responses, and
the third is required only because the base Compose stack runs with
`NODE_ENV=production`.
All three are scoped to `docker-compose.e2e.yml` and must never appear in the
base Compose file or a production environment. Run the Docker quick-start
secret setup before `npm run test:e2e`, because Compose still mounts the secret
files even when AI calls are canned.

To run only the full story-generation spec:

```bash
npm run test:e2e:full
```

### Quality checks

```bash
npm run lint
npm run typecheck
npm run typecheck:all

cd backend
npm run lint
npm run typecheck
npm run typecheck:all
```

CI runs the same checks plus production builds, migration tests, schema audits,
HNSW index tests, security scans, and the E2E suites. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## API documentation

The API is documented with OpenAPI 3.1. The spec is admin-only:

- `GET /api/docs` — JSON specification
- `GET /api/docs/ui` — Redoc UI

Both endpoints require an admin JWT cookie or `Authorization: Bearer
<ADMIN_API_KEY>`. The spec is also available in the repository at
[`backend/src/routes/openapi.ts`](backend/src/routes/openapi.ts).

### Authentication

Most `/api/*` routes require authentication through one of:

1. **JWT cookie** — after login the server sets an httpOnly `access_token`
   cookie. Mutating requests also require the `X-CSRF-Token` header, which is
   supplied from the `XSRF-TOKEN` cookie.
2. **Bearer JWT** — `Authorization: Bearer <jwt>` for scripts and API clients.
3. **Admin API key** — `Authorization: Bearer <ADMIN_API_KEY>` on
   admin-only routes: `/api/admin/*`, `/api/settings*`, and `/api/docs*`.

SSE generation endpoints additionally require an HMAC-SHA256 signature derived
from `API_SECRET` over `jobId:timestamp`.

### Main endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness and dependency health |
| `POST` | `/api/auth/register` | Register a user |
| `POST` | `/api/auth/login` | Log in and set session cookies |
| `POST` | `/api/auth/logout` | Log out and revoke the session |
| `GET` | `/api/auth/me` | Current session user |
| `GET` | `/api/stories` | List the caller's stories |
| `GET` | `/api/stories/:id` | Fetch one story with relations |
| `PATCH` | `/api/stories/:id` | Update story fields |
| `DELETE` | `/api/stories/:id` | Delete a story and related records |
| `POST` | `/api/stories/generate` | Enqueue a generation job |
| `GET` | `/api/stories/generate/:jobId/status` | Poll job state |
| `GET` | `/api/stories/generate/:jobId/events` | Stream SSE progress |
| `PATCH` | `/api/stories/generate/:storyId/episodes/:n` | Regenerate an episode |
| `PATCH` | `/api/stories/generate/:storyId/episodes/:n/scenes/:s` | Regenerate a scene |
| `POST` | `/api/stories/generate/:storyId/regenerate` | Regenerate the full story atomically |
| `GET` | `/api/stories/check-similarity` | Compare a concept with the caller's stories |
| `GET` | `/api/stories/:id/similarity` | Scene similarity matrix |
| `GET` | `/api/stories/:id/confidence` | Quality confidence scores |
| `GET` | `/api/stories/:id/regeneration-history` | Regeneration audit trail |
| `POST` | `/api/stories/:id/export` | Export a story |
| `GET` | `/api/settings` | Read system settings (admin) |
| `PATCH` | `/api/settings/:key` | Update a setting (admin) |
| `DELETE` | `/api/settings/:key` | Delete a setting (admin) |
| `GET` | `/api/user-settings` | Read user preferences |
| `PUT` | `/api/user-settings/:key` | Save a user preference |
| `GET` | `/api/admin/queue` | Queue and dead-letter status (admin) |
| `POST` | `/api/admin/queue/:jobId/restart` | Restart a failed job (admin) |
| `GET` | `/metrics` | Prometheus metrics (loopback or private/Docker networks; narrow with `METRICS_ALLOWED_CIDRS`) |

The OpenAPI document is authoritative; endpoint behavior and request schemas
can change between releases.

## Troubleshooting

### `API_BASE_URL is not configured`

The Next.js proxy cannot reach the backend. Set `API_BASE_URL` in the root
`.env.local` (local development) or in the frontend service environment
(Docker). For Docker the value is `http://backend:34567`.

### `Missing required environment variable` or a placeholder rejection

The backend refuses to start with missing or placeholder secrets in production.
Set real values for `DATABASE_URL`, `REDIS_URL`, `API_SECRET`,
`ADMIN_API_KEY`, and `JWT_SECRET`. Development mode generates ephemeral values
for `API_SECRET` and `ADMIN_API_KEY` when they are unset. `JWT_SECRET` is also
derived when unset, but a separately running frontend still needs the same
explicit value; set it as described in local development.

### Docker Compose cannot find a secret file

Run `bash scripts/generate-secrets.sh --write` from the repository root before
starting the stack. Verify that `secrets/` contains the files referenced in
`docker-compose.yml`. The directory is intentionally ignored by Git.

### Story generation fails immediately

Check that at least one of `MISTRAL_API_KEY` or `KIMI_API_KEY` is set and
reachable from the backend and worker. In Docker, the keys are read from
`secrets/mistral_api_key` and `secrets/kimi_api_key`. Confirm the worker is
running and inspect its logs:

```bash
docker compose logs -f worker backend
```

### Database connection failures

Confirm PostgreSQL is healthy and that `DATABASE_URL` matches the credentials
used by the database service. On Linux (or when host forwarding is available), the development stack
publishes PostgreSQL on host port 15432; the container-to-container URL uses
port 5432. On Docker Desktop for Windows/macOS, use the full Docker stack or a
native PostgreSQL instance instead.

### Migration drift

Apply committed migrations with `npx prisma migrate deploy`. Do not use
`prisma db push` in production; it can drop the pgvector HNSW index and degrade
similarity search. The CI migration job verifies that migrations match the
schema.

### Registration is rejected

If `DISABLE_REGISTRATION=true`, registration requires `INVITE_CODE`. If the
first user should become an admin, set `BOOTSTRAP_FIRST_USER_ADMIN=true` before
registering, or promote the user through Prisma Studio.

### Redis append-only file corruption

See [`docs/runbook-redis.md`](docs/runbook-redis.md) for the recovery
procedure and the container startup guard.

### Ports already in use

The development stack binds API port 34567 and frontend port 3000. Stop the
conflicting process or change the published ports in a local Compose override.
Do not edit the production Compose file just to resolve a local conflict.

### Tests fail because the database or Redis is unavailable

The unit suites mock their dependencies, but integration and E2E tests need the
Docker stack. Start it with `docker compose up -d` (or use the `test:e2e`
script, which starts the stack for you).

## Security

Security-relevant behavior in this repository includes:

- JWT sessions in httpOnly cookies with CSRF double-submit protection.
- Separate `API_SECRET`, `ADMIN_API_KEY`, and `JWT_SECRET` values.
- Admin-only access to settings, queue management, statistics, and the OpenAPI
  document.
- Helmet security headers on the API, security headers in `next.config.ts`, and a per-request nonce-based CSP in `proxy.ts`.
- Zod validation on request bodies and query parameters.
- Rate limiting, AI quotas, and token budgets.
- Docker secrets for sensitive configuration; `.env` and `secrets/` are
  gitignored and excluded from Docker build contexts.
- Production environment validation that rejects placeholders and weak
  development values.
- Copyright and content checks in the generation pipeline.

Do not report security vulnerabilities in public issues. Follow
[`SECURITY.md`](SECURITY.md) for private reporting and scope. Never commit API
keys, `.env` files, or generated secrets.

## Contributing

Contributions are welcome under the terms described in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Read it before opening a pull request.
Use the issue templates for bug reports and feature requests, and run the
documented checks before submitting.

- [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml)
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml)
- [Pull request template](.github/PULL_REQUEST_TEMPLATE.md)

## License

Released under the [MIT License](LICENSE).

The code copyright belongs to Jessi-John. A license audit of the direct
dependencies found only permissive licenses (MIT, ISC, Apache-2.0, and
BSD-2-Clause; the single MPL-2.0 package, `axe-core`, is used for
development-time accessibility testing only), and is compatible with this
distribution. Code contributed through pull requests is accepted under
[Developer Certificate of Origin-style](https://developercertificate.org/)
assurances; see the [contributing guide](CONTRIBUTING.md).
