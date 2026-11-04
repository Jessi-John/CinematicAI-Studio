# CinematicAI Studio

AI-powered story generator for creating original hand-painted storybook anime YouTube Shorts.

## Overview

CinematicAI Studio enables creators to generate complete anime story arcs (10 episodes × 5 scenes) with:
- AI-generated character bibles and world settings
- Scene-by-scene visual descriptions for image/video generation
- YouTube SEO metadata (titles, descriptions, tags, thumbnails)
- Quality scoring and improvement recommendations

The pipeline runs asynchronously via BullMQ with real-time progress via Server-Sent Events.

---

## Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Frontend | Next.js (App Router), React, TanStack Query, Zustand, Tailwind v4, Framer Motion | Next.js 16.2, React 19 |
| Backend | Express.js, BullMQ, Prisma (PostgreSQL + pgvector), Redis pub/sub | Node.js 20 |
| AI | Mistral (primary — chat + embeddings), Kimi K3 (fallback) | — |
| Infrastructure | PostgreSQL 16, Redis 7, Docker | — |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                     │
│                                                             │
│  ┌──────────────┐    ┌─────────────────┐    ┌───────────┐  │
│  │   frontend    │HTTP│  Express API    │    │  worker   │  │
│  │  (Next.js)    │◄──►│  (port 34567)   │enq│  (BullMQ) │  │
│  │  (port 3000)  │    │                 │   │  (container)│  │
│  └──────────────┘    └────────┬────────┘    └─────┬─────┘  │
│                               │                    │        │
│                               ▼                    ▼        │
│                    ┌──────────────────┐  ┌──────────────┐  │
│                    │   Redis (pub/sub) │  │   Redis     │  │
│                    │   rate-limit      │  │   (queue)   │  │
│                    └──────────────────┘  └──────┬───────┘  │
│                                                 │          │
│                                                 ▼          │
│                                        ┌───────────────┐  │
│                                        │  PostgreSQL   │  │
│                                        │  + pgvector   │  │
│                                        └───────────────┘  │
│                                                             │
│   External: Mistral (primary) + Kimi K3 (fallback) AI APIs    │
└─────────────────────────────────────────────────────────────┘
```

### Component Topology

| Component | Port | Purpose |
|-----------|------|---------|
| `frontend` | 3000 | Next.js user-facing web UI |
| `backend` | 34567 | Express REST API + SSE |
| `worker` | separate container | BullMQ async story generation |
| `postgres` | 5432 | Primary DB + pgvector similarity search |
| `redis` | 6379 | Job queue, pub/sub, rate limiting |

### Communication Protocols

- **HTTP/REST** — Frontend → Backend API
- **Server-Sent Events (SSE)** — Backend → Frontend for job progress (backed by Redis pub/sub)
- **BullMQ** — In-process job enqueueing via `ioredis`
- **Prisma/PostgreSQL** — SQL queries for all persistent data

### Story Generation Pipeline

```
User clicks "Generate"
  │
  ▼
POST /api/stories/generate → BullMQ job enqueued
  │
  ▼
Worker: GEN_CHARACTER_BIBLE → Mistral/Kimi AI
  │ → GEN_WORLD_BIBLE → Mistral/Kimi AI
  │ → GEN_EPISODES (10 episodes) → Mistral/Kimi AI
  │ → GEN_SCENES (50 scenes) → Mistral/Kimi AI
  │ → GEN_SEO → Mistral/Kimi AI
  │ → EMBEDDING + STORAGE → PostgreSQL + pgvector
  │ → QUALITY SCORING → humanization + quality analysis
  │
  ▼
SSE: "complete" event with story data
  │
  ▼
UI: Display generated story with quality scores
```

---

## Setup

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- An AI provider API key (Kimi or Mistral — see `.env.example`)

### Option 1: Docker (Recommended)

```bash
# Clone and configure
git clone <repo>
cd youtube
cp .env.example .env
# Edit .env: set one or more AI provider keys (KIMI_API_KEY or MISTRAL_API_KEY)

# Start all services
docker compose up -d

# Verify
curl http://localhost:34567/api/health
```

### Option 2: Local Development

```bash
# 1. Start infrastructure
docker compose up -d postgres redis

# 2. Backend
cd backend
npm install
cp .env.example .env
# Edit .env: set AI provider key(s), DATABASE_URL, REDIS_URL
npm run db:generate
npm run db:push  # dev only
npm run dev      # API on :34567 (worker runs as a separate container in Docker)

# 3. Frontend (separate terminal)
cd ..
npm install
npm run dev      # Next.js on :3000
```

### Login

Navigate to http://localhost:3000/register and create an account. To grant admin
privileges, update the user's `role` to `admin` directly in the PostgreSQL
`User` table (or via `npx prisma studio`), then log in at
http://localhost:3000/login.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MISTRAL_API_KEY` | At least one | — | Mistral — primary for all story-generation stages + embeddings |
| `KIMI_API_KEY` | At least one | — | Kimi K3 — fallback for blueprints, bibles, episodes, scenes, SEO |
| `MISTRAL_BASE_URL` | No | `https://api.mistral.ai/v1` | Mistral API endpoint |
| `MISTRAL_MODEL` | No | `mistral-medium-2508` | Mistral model |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection |
| `PORT` | No | `34567` | Server port |
| `API_SECRET` | Prod | — | SSE HMAC signature + webhook signing (not bearer auth) |
| `ADMIN_API_KEY` | Prod | — | Admin auth (`/api/admin/*` bearer or-cookie JWT admin) |
| `RUN_WORKER_INPROCESS` | No | `false` | Worker mode — set `true` for dev single-process only |
| `WORKER_CONCURRENCY` | No | `2` | Concurrent jobs |
| `CORS_ORIGINS` | No | `http://localhost:3000` | Comma-separated allowed origins |

### Frontend (build-time)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:34567` | Backend URL for browser |

---

## API Surface

### Authentication

All `/api/*` routes (except `/api/health`, `/api/public-config`, and `/api/auth/*`) require authentication via one of:

1. **JWT Cookie** (browser): After login, the server sets an `access_token` httpOnly cookie. Subsequent requests are automatically authenticated via the cookie. CSRF protection uses the double-submit pattern: the server sets an `XSRF-TOKEN` cookie, and the client echoes it as an `X-CSRF-Token` header on mutating requests (POST/PUT/PATCH/DELETE).

2. **Bearer JWT** (scripts/API clients): Include the JWT token in the `Authorization` header:
   ```
   Authorization: Bearer <jwt_token>
   ```

3. **Admin API Key** (server-to-server): Admin routes (`/api/admin/*`) accept an `ADMIN_API_KEY` via Bearer token:
   ```
   Authorization: Bearer <ADMIN_API_KEY>
   ```

SSE endpoints require HMAC-SHA256 signature: `hmacSha256(apiSecret, jobId:timestamp)`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service status (no auth) |
| `POST` | `/api/auth/register` | Register first user (admin only when `DISABLE_REGISTRATION=true` or `BOOTSTRAP_FIRST_USER_ADMIN=true`; otherwise first user is `user` role) |
| `POST` | `/api/auth/login` | Cookie-based login |
| `POST` | `/api/auth/logout` | Logout and revoke token |
| `GET` | `/api/auth/me` | Current session user |
| `GET` | `/api/stories` | List stories (paginated) |
| `GET` | `/api/stories/:id` | Fetch single story with all relations |
| `PATCH` | `/api/stories/:id` | Update title/status/theme/seed |
| `DELETE` | `/api/stories/:id` | Delete story (cascade) |
| `POST` | `/api/stories/generate` | Enqueue generation job → `{ jobId }` |
| `GET` | `/api/stories/generate/:jobId/status` | Poll job state |
| `GET` | `/api/stories/generate/:jobId/events` | SSE progress stream |
| `PATCH` | `/api/stories/generate/:storyId/episodes/:n` | Regenerate episode |
| `PATCH` | `/api/stories/generate/:storyId/episodes/:n/scenes/:s` | Regenerate scene |
| `POST` | `/api/stories/generate/:storyId/regenerate` | Full atomic regeneration |
| `GET` | `/api/stories/check-similarity` | Duplicate concept detection (query: `genre` required, `seed` optional) |
| `GET` | `/api/stories/:id/similarity` | Scene similarity matrix |
| `GET` | `/api/stories/:id/confidence` | Quality confidence scores |
| `GET` | `/api/stories/:id/regeneration-history` | Edit/regen audit trail |
| `POST` | `/api/stories/:id/export` | Export as JSON/CSV/TXT/SSML/SRT/VTT |
| `GET` | `/api/settings` | All system settings |
| `GET` | `/api/settings/:key` | Single setting |
| `PUT` | `/api/settings/:key` | Upsert setting |
| `PUT` | `/api/settings` | Batch upsert |
| `DELETE` | `/api/settings/:key` | Delete setting |
| `GET` | `/api/user-settings` | User preferences |
| `PUT` | `/api/user-settings` | Save preference |
| `GET` | `/api/admin/queue` | Dead letter queue status |
| `POST` | `/api/admin/queue/:jobId/restart` | Restart failed job |
| `GET` | `/metrics` | Prometheus metrics (localhost only) |

---

## Data Model

```
Story (1) ──── (N) Episode ──── (N) Scene
         ├─── (N) Character
         ├─── (N) Environment
         ├─── (0/1) YouTubeSEO
         └─── (N) GenerationLog
```

### Core Entities

| Entity | Description |
|--------|-------------|
| **Story** | Aggregate root — 10 episodes × 5 scenes, genre, quality scores, pgvector embedding |
| **Episode** | Story segment (~50s) with synopsis, hook, cliffhanger, version for optimistic locking |
| **Scene** | Single visual moment — narration, image prompt, video prompt, camera settings, character/environment state |
| **Character** | Character bible — name, appearance, personality, speech patterns, relationships, catchphrases |
| **Environment** | World setting — name, description, type, timeOfDay, weather, mood, lighting setup |
| **YouTubeSEO** | SEO metadata — title, description, tags, thumbnail suggestions, hook/CTA scripts, viral potential |
| **GenerationLog** | Audit trail — all edit and regeneration events with details |

### Indexes

- `stories.embedding` — HNSW (pgvector) for semantic similarity
- `episodes(storyId, number)` — unique compound
- `scenes(episodeId, number)` — unique compound
- `generation_logs(storyId, createdAt)` — for audit queries

---

## Domain Terminology

| Term | Definition |
|------|------------|
| **Story** | A generated anime narrative with 10 episodes and 50 scenes |
| **Episode** | A single segment within a story (~50s duration), contains 5 scenes |
| **Scene** | A single visual moment with narration, image prompt, video prompt, camera settings |
| **Character Bible** | AI-generated profiles for main characters (name, appearance, personality, speech) |
| **World Bible** | AI-generated environment descriptions and supporting cast |
| **Humanization Score** | Metric for how naturally-written the narration sounds (0-100) |
| **Quality Score** | Structural quality of the story (0-100) |
| **Monetization Score** | Estimated revenue potential based on SEO attributes |
| **Virality Score** | Estimated viral potential based on algorithm tips |
| **Story Arc Type** | Narrative structure (classic, etc.) |
| **Seed Story** | An existing story used as structural template for a new story |

---

## Scripts

### Frontend (root)

| Script | Command |
|--------|---------|
| `dev` | Next.js dev server |
| `build` | Production build |
| `start` | Production server |
| `lint` | ESLint |
| `typecheck` | `tsc --noEmit` |
| `test:e2e` | Playwright (requires servers running) |

### Backend (`backend/`)

| Script | Command |
|--------|---------|
| `dev` | `tsx watch` — API + in-process worker (dev only) |
| `build` | Compile to `dist/` |
| `start` | Run compiled output |
| `worker` | Standalone worker process |
| `db:generate` | `prisma generate` |
| `db:push` | `prisma db push` (dev) |
| `db:migrate` | `prisma migrate dev` |
| `db:deploy` | `prisma migrate deploy` (production) |
| `db:studio` | Prisma Studio GUI |
| `test` | Vitest unit tests |
| `lint` | ESLint |

---

## Testing

| Type | Framework | Location |
|------|-----------|----------|
| Unit tests | Vitest | `backend/` |
| E2E tests | Playwright | `e2e/` |

```bash
# Backend unit tests
cd backend && npm test

# E2E (requires dev servers)
npm run test:e2e
```

---

## Configuration

### Database Schema

The Prisma schema is at `backend/prisma/schema.prisma`. All migrations live in `backend/prisma/migrations/`.

Key settings stored in `system_settings` table:

| Key | Default | Purpose |
|-----|---------|---------|
| `quality_floor` | `70` | Minimum quality score |
| `grade_floor` | `C` | Minimum quality grade |
| `humanization_score_limit` | `80` | Max humanization score |
| `humanization_story_budget` | `50` | Token budget per story |
| `humanization_story_quality_retries` | `2` | Retry attempts on low quality |

### Rate Limits

- General API: 100 requests/minute per IP
- Auth routes: 10 requests/minute per IP
- SSE events: 50 events/second per connection (bursts are queued, not dropped)
- Worker: 10 jobs per 60 seconds

### Timeouts

| Operation | Timeout |
|-----------|---------|
| AI provider request (per attempt) | 120s |
| Database query | 10s (`statement_timeout`) |
| SSE connection | 2h hard ceiling (reconnect to resume) |

---

## Security

- **JWT cookie auth** (`access_token` httpOnly, SameSite=strict) on all `/api/*` routes (except `health`, `public-config`, `auth/*`, SSE HMAC routes); `Authorization: Bearer <jwt>` accepted as a fallback (cookie takes precedence)
- **Admin auth** via `ADMIN_API_KEY` Bearer header OR an admin-role JWT cookie / Bearer JWT (privilege-separated from API_SECRET — `API_SECRET` never grants admin access)
- **CSRF protection** via double-submit cookie pattern (`XSRF-TOKEN` cookie + `X-CSRF-Token` header on mutations)
- **SSE / generation polling auth**: HMAC-SHA256 signature using `API_SECRET` (`hmacSha256(apiSecret, jobId:timestamp)`)
- **Security headers** via Helmet (CSP, HSTS, X-Frame-Options, etc.)
- **Rate limiting** on all routes
- **Circuit breaker** on AI calls (5 consecutive failures → open; reset timeout starts at 60s and doubles per open cycle, capped at 30min)
- **Optimistic locking** on episodes/scenes (version field)
- **Input validation** via Zod schemas on all requests

**Note**: `API_SECRET` is a multi-purpose bearer/HMAC sym key for SSE auth + webhook signing — it is **not** used for ordinary `/api/*` bearer auth (those use JWT cookies or `Authorization: Bearer <jwt>`). Keep `API_SECRET` and `ADMIN_API_KEY` confidential; rotate both on any suspected leak.

---

## Resilience Patterns

| Pattern | Implementation |
|---------|----------------|
| Retry with backoff | `withRetry()` — 3 attempts, exponential backoff, max 10s delay |
| Circuit breaker | `ai-client.ts` — opens after 5 consecutive failures; 60s reset doubling to a 30min cap |
| Optimistic locking | Episodes/scenes have `version` field; conditional updates |
| Atomic regeneration | `replaceStoryAtomically()` — PostgreSQL transaction delete+create |
| Dead letter queue | `story-generation-dlq` — admin can restart via `/api/admin/queue/:jobId/restart` |
| Graceful degradation | SSE falls back to HTTP polling on connection failure |

---

## Observability

### Logging

- **Library**: Pino (JSON in production, pretty-print in dev)
- **Request ID**: `X-Request-ID` header injected on every request for log correlation
- **Key events**: request start/end, job enqueue/complete, AI requests, auth failures

### Metrics

- **Endpoint**: `GET /metrics` (localhost only)
- **Library**: prom-client (Prometheus)
- **Custom metrics**: HTTP request count/duration, story generation count/duration, AI token usage

---

## Deployment

### Docker

```bash
# Production build
docker-compose up -d

# Backend starts first (prisma migrate deploy → node dist/server.js)
# Then frontend
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set real `API_SECRET` and `ADMIN_API_KEY` (not dev fallbacks)
- [ ] Set `RUN_WORKER_INPROCESS=false` for process isolation
- [ ] Configure `DATABASE_URL` accessible from container
- [ ] Configure `REDIS_URL` accessible from container
- [ ] Set `CORS_ORIGIN` to your frontend domain
- [ ] Bind backend to `0.0.0.0` (not `localhost`) for Docker networking

### Health Checks

- **Liveness**: `GET /api/health` — returns `{ status, database, redis, timestamp }`
- **Graceful shutdown**: SIGTERM → `server.close()` + `prisma.$disconnect()` + Redis quit

---

## Tech Debt & Known Issues

| Issue | Impact | Workaround |
|-------|--------|------------|
| In-process worker (dev default) | Worker crashes affect API server | Set `RUN_WORKER_INPROCESS=false` in production |
| Single Redis pub/sub subscriber | SSE stalls if Redis connection dies | Frontend falls back to HTTP polling |
| CSRF cookie not httpOnly | XSS could read CSRF token | Ensure no XSS vulnerabilities in frontend |

---

## Contributing

No formal contribution guidelines. Key files:

- `backend/prisma/schema.prisma` — canonical data model
- `backend/src/config/env.ts` — environment validation
- `backend/src/server.ts` — Express app entry point
- `backend/src/queue/workers/run-worker.ts` — story generation pipeline

---

### Admin Setup

After first run, create an admin user by calling POST /api/auth/register with username and password, then manually set role to 'admin' in the database.

## License

Proprietary. All rights reserved.