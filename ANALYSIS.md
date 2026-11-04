# CinematicAI Studio — Comprehensive Codebase Analysis

> Generated from an exhaustive line-by-line analysis of every source file in the repository.
> Date: 2026-08-15.
> Scope: ~250 source-tracked files, ~35,000 LOC across frontend, backend, infra, deploy, CI/CD, and tests.

---

## Table of Contents

1. [Project Summary](#1-project-summary)
2. [System Topology](#2-system-topology)
3. [Repository Layout](#3-repository-layout)
4. [Backend Deep-Dive](#4-backend-deep-dive)
   - 4.1 [Server Bootstrap](#41-server-bootstrap-backendsrcserverts)
   - 4.2 [Configuration](#42-configuration-backendsrcconfig)
   - 4.3 [Domain Layer](#43-domain-layer-backendsrcservices)
   - 4.4 [AI Abstraction](#44-ai-abstraction-backendsrclibaiclientts)
   - 4.5 [11-Stage Pipeline](#45-11-stage-pipeline)
   - 4.6 [HTTP Routes](#46-http-routes-backendsrcroutes)
   - 4.7 [Middleware](#47-middleware-backendsrcmiddleware)
   - 4.8 [Database Layer](#48-database-layer-backendsrcdatabase)
   - 4.9 [Background Workers](#49-background-workers-backendsrcqueueworkers)
   - 4.10 [Cross-Cutting Libs](#410-cross-cutting-libs-backendsrclib)
5. [Frontend Deep-Dive](#5-frontend-deep-dive)
   - 5.1 [Routing Tree](#51-routing-tree)
   - 5.2 [BFF Proxy](#52-bff-proxy-appapipathroutets)
   - 5.3 [State Management](#53-state-management)
   - 5.4 [Auth Flow](#54-auth-flow)
   - 5.5 [Component Library](#55-component-library)
   - 5.6 [Custom Hooks](#56-custom-hooks)
6. [Data Model](#6-data-model-backendprismaschemaprisma)
7. [Security Posture](#7-security-posture)
8. [Observability](#8-observability)
9. [Deployment & Infrastructure](#9-deployment--infrastructure)
10. [CI/CD Pipeline](#10-cicd-pipeline)
11. [Testing Strategy](#11-testing-strategy)
12. [Custom Tooling](#12-custom-tooling)
13. [Key File Reference](#13-key-file-reference)
14. [Notable Architectural Decisions](#14-notable-architectural-decisions)

---

## 1. Project Summary

**CinematicAI Studio** is an AI-powered story generator that produces hand-painted anime YouTube Shorts narratives. Each story is structured as **10 episodes × 5 scenes** (50 scenes per story), accompanied by AI-generated character/world bibles, scene-by-scene image and video prompts, YouTube SEO metadata, and quality scoring.

The pipeline runs asynchronously via **BullMQ** with real-time progress streamed back to the browser over **Server-Sent Events** (HMAC-signed). Primary AI provider is **Mistral** (`mistral-medium-2508` for chat, `mistral-embed-2312` for 1024-dim embeddings) with **Kimi K3** as fallback.

**Stack at a glance:**

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16.2 (App Router), React 19, TanStack Query, Zustand, Tailwind v4, Framer Motion |
| Backend | Express, BullMQ, Prisma (PostgreSQL 16 + pgvector + pg_trgm), Redis 7 |
| Edge | Caddy 2 (auto-TLS, security headers) |
| Observability | Pino, OpenTelemetry → Jaeger, Prometheus, Alertmanager, Loki + Promtail, Grafana |
| Testing | Vitest (unit/integration), Playwright (E2E), axe-core (a11y) |
| Tooling | ESLint + custom plugin, Commitlint, Husky, TruffleHog, Trivy, ZAP |

---

## 2. System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                      Docker Compose Stack                       │
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │   Caddy     │    │  frontend     │    │     backend        │  │
│  │   :443      │◄──►│  Next.js     │HTTP│  Express :34567   │  │
│  │  (auto-TLS) │    │  :3000       │    │  (REST + SSE)     │  │
│  └─────────────┘    └──────┬───────┘    └────────┬───────────┘  │
│                            │  ▲                  │  ▲  enqueue  │
│                            │  │ BFF proxy        ▼  │           │
│                            │  │           ┌──────────────┐      │
│                            │  │           │  Redis :6379 │      │
│                            │  │           │  Queue + Pub │      │
│                            │  │           └──────┬───────┘      │
│                            │  │                  │              │
│                            │  │           ┌──────▼───────┐      │
│                            │  │           │   Worker     │      │
│                            │  │           │  BullMQ proc │      │
│                            │  │           │  :3001 heal  │      │
│                            │  │           │  :3002 metr  │      │
│                            │  │           └──────┬───────┘      │
│                            │  │                  │              │
│                            │  │           ┌──────▼───────┐      │
│                            │  └──────────►│  PostgreSQL  │      │
│                                         │  :5432        │      │
│                                         │  pgvector     │      │
│                                         │  pg_trgm      │      │
│                                         └──────────────┘      │
│                                                                 │
│  External: Mistral AI (primary) + Kimi K3 (fallback)            │
└─────────────────────────────────────────────────────────────────┘
```

**Two Docker networks:**
- `default` (bridge) — public-facing / monitoring plane
- `internal` (bridge, `internal: true`) — data plane (backend/worker ↔ postgres/redis); no outbound internet, no cross-network reach

**Component ports:**

| Service | Container | Host |
|---------|-----------|------|
| postgres | 5432 | 127.0.0.1:15432 |
| redis | 6379 | 127.0.0.1:6379 |
| jaeger | 16686 | 127.0.0.1:16686 |
| backend | 34567 | 127.0.0.1:34567 |
| worker | 3001, 3002 | 127.0.0.1:3001, 127.0.0.1:3002 |
| frontend | 3000 | 127.0.0.1:3000 |
| prometheus | 9090 | 127.0.0.1:9090 |
| redis-exporter | 9121 | 127.0.0.1:9121 |
| alertmanager | 9093 | 127.0.0.1:9093 |
| loki | 3100 | 127.0.0.1:3100 |
| grafana | 3000 | 127.0.0.1:3003 |

---

## 3. Repository Layout

```
D:\youtube\
├── app/                          # Next.js App Router (frontend)
│   ├── (dashboard)/              # Auth-protected route group
│   │   ├── admin/                # Admin panel (queue, DLQ, stats)
│   │   ├── create/               # Story creation wizard
│   │   ├── history/              # Story archive
│   │   ├── settings/             # User preferences
│   │   ├── story/[id]/           # Story detail (server + client split)
│   │   │   └── episode/[episodeId]/
│   │   ├── layout.tsx            # RequireAuth wrapper
│   │   ├── page.tsx              # Dashboard
│   │   └── page.test.tsx
│   ├── api/[...path]/route.ts    # BFF catch-all proxy → Express
│   ├── login/, register/
│   ├── error.tsx, not-found.tsx
│   ├── layout.tsx                # Root layout (CSP nonce, providers)
│   └── globals.css
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma         # 11 models
│   │   └── migrations/           # 30 migrations
│   └── src/
│       ├── server.ts             # Express bootstrap
│       ├── config/               # env validation, secrets loading
│       ├── database/             # Prisma + storage helpers
│       ├── lib/                  # Cross-cutting utilities
│       ├── middleware/           # auth, csrf, rate-limit, …
│       ├── quality/              # Deterministic penalty engine
│       ├── humanization/         # Rhythm-based AI detection
│       ├── queue/                # BullMQ + Redis pub/sub
│       │   └── workers/
│       │       ├── pipeline/     # 11-stage orchestrator + stages
│       │       └── *.worker.ts   # Background workers
│       ├── routes/               # Express HTTP handlers
│       ├── services/             # Domain logic
│       ├── scripts/              # CLI utilities
│       ├── server/               # Metrics ACL
│       ├── test/                 # Vitest setup
│       ├── test-quality/         # Cross-cutting invariant tests
│       └── types/                # Express augmentation
├── components/                   # Shared UI primitives
│   ├── dashboard/, generation/, layout/, story/, ui/
├── hooks/                        # use-generation (SSE orchestrator)
├── lib/                          # Frontend utilities
│   ├── accessibility/, auth/, constants/, query/, stores/, utils/
├── types/                        # Frontend domain types (re-export)
├── deploy/                       # Caddy, Grafana, Loki, Alertmanager, Backup
├── prometheus/                   # Prometheus + Alertmanager configs
├── scripts/                      # CI local, secret gen, version sync, …
├── secrets/                      # 12 Docker secrets (mode 600)
├── e2e/                          # Playwright specs
├── eslint-plugins/               # Custom ESLint plugin (7 rules)
├── public/                       # runtime-config.js template
├── test/                         # Vitest setup (frontend)
├── types/                        # Root-level shared types
├── docker-compose.yml            # Local dev stack (13 services)
├── docker-compose.prod.yml       # Production override (Caddy + cost caps)
├── docker-compose.e2e.yml        # E2E bypass flags
├── Dockerfile                    # Frontend multi-stage build
├── next.config.ts                # Security headers, standalone output
├── proxy.ts                      # Edge middleware (CSP nonce)
└── package.json
```

---

## 4. Backend Deep-Dive

The backend contains **54 non-test `.ts` source files** + ~50 test files, totaling ~17,500 LOC. It is built around a **strict import order** in `server.ts` and `run-worker.ts`:

```
tracing → http-transport → load-env → validateAndLoadEnv
```

### 4.1 Server Bootstrap (`backend/src/server.ts`)

`server.ts` (636 lines) wires up the entire Express app. Key behaviors:

| Lines | Behavior |
|-------|----------|
| 1–34 | **Contractual import order**: tracing → undici dispatcher → load-env → env validation |
| 65–80 | Refuses to start in production if `RUN_WORKER_INPROCESS=true` |
| 80 | `x-powered-by` disabled, `trust proxy=1` |
| 91–100 | Per-request idle timeout (default 5 min, env-configurable) |
| 105–143 | Helmet with strict CSP (no inline scripts); scoped relaxation ONLY on `/api/docs` for Redoc |
| 144–178 | CORS allowlist computed lazily after env validation |
| 186–203 | **Depth-limited JSON parser** (`checkJsonDepth` rejects nested JSON > 32) |
| 218–226 | **URI cap 2048 chars** on `/api/stories/generate` |
| 229–240 | `/health` (no auth), `/public-config`, `/alerts`, `/docs` mounted first |
| 249–257 | Per-endpoint rate limiters (`registerLimiter`, `loginLimiter`) |
| 262–269 | Per-prefix middleware chain: `apiAuth → jwt → validateIdParam → csrf → generalLimiter → perUserLimiter` |
| 296–303 | `/metrics` CIDR ACL (loopback + RFC1918) |
| 311–341 | `checkRedisVersion()` — enforces Redis 6.2+ (BullMQ 5.x needs BLMOVE) |
| 343–413 | `checkHnswIndexExists` — verifies pgvector HNSW index with `vector(1024)`; production-hard fail; schedules 30-min recheck + 6h reindex |
| 415–565 | `start()` — DB connect, CORS init, schedule HNSW, optional in-process worker |
| 523–563 | Drain-aware shutdown: `server.close` + `closeIdleConnections` + hard ceiling |
| 585–607 | Cleanup: `closeQueues`, `closePubSub`, `closeSharedRedis`, `prisma.$disconnect()` |
| 615–627 | ESM-safe `isMainModule` check via `fileURLToPath(import.meta.url)` |

**Middleware pipeline (in order):**
```
requestId → requestLogger → helmet → CORS → JSON/urlencoded/cookie-parser
→ SSE URI cap (only on /stories/generate)
→ /health (no auth)
→ /public-config (no auth)
→ /alerts (separate bearer-token auth)
→ /docs (admin-only)
→ [both /api and /api/v1 prefixes]
  → /auth/* (per-endpoint limiters, no JWT)
  → apiAuthMiddleware (SSE/HMAC passthrough)
  → jwtMiddleware
  → validateIdParam
  → csrfMiddleware
  → generalLimiter
  → perUserLimiter
→ Routers
→ /metrics (CIDR allowlisted)
→ notFoundHandler → errorHandler
```

### 4.2 Configuration (`backend/src/config/`)

**`env.ts` (664 lines)** — strict env validation with cached getters. Notable rules:

- **Required** in production: `DATABASE_URL`, `REDIS_URL`, `REDIS_PASSWORD`, `API_SECRET`, `ADMIN_API_KEY`, `JWT_SECRET`
- **27 placeholder patterns** rejected (`__SET_ME_*`, `local_dev_*`, `dev_*`, `test_password`, etc.)
- 22–37: `readSecretFile()` reads `/run/secrets/{name}` first, warns on permissive mode
- 39–43: `secretOrEnv()` — secret file takes precedence
- 174–185: `demand()` — strict throw on missing or placeholder
- 276–292: `API_SECRET` — production-required; otherwise `crypto.randomBytes(32)` per process (insufficient for multi-replica)
- 313–326: `JWT_SECRET` — derived as `sha256(API_SECRET + ':jwt')` when not provided (separate from API_SECRET)
- 516–535: `e2eTestBypassEnabled()` / `cannedModeEnabled()` — refuse to bypass in production unless explicit opt-in

**`load-env.ts` (77 lines)** — multi-source `.env` loading (DPAPI no-op, repo root + backend/.env, never overrides OS env).

**`windows-secrets.ts` (25 lines)** — no-op stub kept for backward compatibility.

### 4.3 Domain Layer (`backend/src/services/`)

**`types.ts` (253 lines)** — canonical domain types. The frontend re-exports from here.

**Genre union** (21 genres):
`fantasy`, `adventure`, `romance`, `horror`, `mystery`, `thriller`, `sci-fi`, `drama`, `comedy`, `action`, `emotional`, `mythology`, `historical`, `slice-of-life`, `dark-fantasy`, `psychological`, `inspirational`, `kids`, `survival`, `anime-style`, `viral-trend`

**Story status FSM:**
```
draft ──► generating ──► complete
                  └────► failed ──► draft (API only)
complete is terminal
```

**Camera types** (8): `static`, `tracking`, `dolly`, `crane`, `handheld`, `aerial`, `pan`, `tilt`.

**Transition types** (4): `cut`, `dissolve`, `fade`, `wipe`.

**Emotion** (6): `neutral`, `happy`, `dramatic`, `intense`, `mysterious`, `sad`.

**Key services:**

| Service | Lines | Purpose |
|---------|-------|---------|
| `character-bible.ts` | 411 | AI-generated bible with `ROLE_SYNONYMS` duplicate guard + retry loop |
| `world-bible.ts` | 583 | Antagonist + supporting + environments; per-genre archetype fallback |
| `uniqueness.ts` | 321 | `analyzeExistingStories` (RepeatableRead tx), per-genre theme pools |
| `quality-judge.ts` | 312 | LLM-as-judge with 12 sub-scores, 3-attempt repair loop |
| `token-budget.ts` | 1083 | Atomic Lua check + reserve + refund + reconcile + in-memory fallback |
| `settings.ts` | 212 | LRU + in-flight coalescing cache for `system_settings` |
| `user-settings.ts` | 287 | Per-user `user_settings` with cache |
| `similarity.ts` | 353 | Semantic (pgvector HNSW, cosine > 0.88) + lexical (pg_trgm, > 0.72) dedup |
| `generation-logger.ts` | 504 | `logGeneration/Retry/Fallback/Regeneration`, similarity matrix, confidence |
| `webhook.ts` | 399 | SSRF protection (URL blocklist, DNS-rebind protection, IP-pinned undici) |
| `story-regeneration.ts` | 176 | `regenerateStory` (atomic replace via `preloadedStory`) |
| `episode-regeneration.ts` | 305 | Single episode rewrite with token-budget gate + optimistic lock |
| `scene-regeneration.ts` | 345 | Single scene retry, similarity/monetization gates, version lock |
| `concept-registry.ts` | 140 | Redis SET NX in-flight title/name-prefix claim |
| `audit-log.ts` | 50 | Non-fatal audit writes |
| `generation-helpers.ts` | 53 | `findCharacters`, `buildCharacterBible`, `GENRE_LIST` |

### 4.4 AI Abstraction (`backend/src/lib/ai-client.ts`, 1321 lines)

**Primary entry:** `generateWithMistral()` — Mistral-then-Kimi fallback chain.

**State & infrastructure:**

| Lines | Behavior |
|-------|----------|
| 18–25 | `AIPipelineContext` interface (jobId, abortSignal, cannedFallbackEnabled) |
| 66 | `AsyncLocalStorage<AIPipelineContext>` for context binding |
| 72–84 | `runWithAIPipelineContext()` — M11 context binding |
| 146–196 | `__createRateLimiter` + `__waitForRateLimit` — mutex sliding window: Mistral 20/60s, Kimi 30/60s |
| 237–259 | `mistralCircuitBreaker` — threshold 5, reset 60s, exponential backoff 60s→1800s |
| 250–259 | `kimiCircuitBreaker` — identical config |
| 495–532 | `createHalfOpenProbeLock` — Promise-mutex, `STALE_PROBE_TTL_MS=240000` |
| 649–827 | `callMistral` — circuit check, rate limit, `ATTEMPT_TIMEOUT_MS=120s`, watchdog, retry 2x, token recording |
| 833–1004 | `callKimi` — identical structure, default `temperature: 1` |
| 1042–1109 | `generateWithMistral` — canned fallback, `areAllProvidersUnavailable` guard |
| 1113–1177 | `generateYouTubeSEO` — validates title ≤100, hook in first 125 chars, falls back to default |
| 1179–1286 | `validateAndFillSEO` — enforces all invariants with defaults |
| 1297–1321 | `getDefaultYouTubeSEO` — returns `isPlaceholder: true` internal flag |

**Canned mode** (`ai-client.canned.ts`, 417 lines) — deterministic responses for E2E. Shape detection: blueprint/scene/episode-meta/seo/similarity/character-bible/world-bible/humanize/rebalance/title-unique.

**Other lib utilities:**

| File | Lines | Purpose |
|------|-------|---------|
| `embeddings.ts` | 247 | Mistral `mistral-embed-2312` (1024-dim) + Redis 90-day cache + circuit breaker |
| `copyright-filter.ts` | 635 | 3-tier content filter (see §7) |
| `episode-generator.ts` | 1995 | Stage 5 episode/scene generation, retry/rebalance/dedupe |
| `prompt-engine.ts` | 374 | Genre-aware image/video prompt builder |
| `story-builder.ts` | 378 | Build full `Story` from episodes + bibles |
| `quality-refiner.ts` | 190 | Targeted refinement plan generator + applier |
| `humanization/` (index.ts) | 281 | Rhythm-based AI detection |
| `subtitle-export.ts` | 249 | SSML / SRT / VTT subtitle exporters |
| `tts-normalize.ts` | 125 | Numbers→words, abbreviations, smart-punct |
| `style-packs.ts` | 1048 | Per-genre visual style packages |
| `genre-guard.ts` | 328 | Post-generation deterministic genre validation |
| `genre-directives.ts` | 368 | Per-genre required/forbidden vocabulary |
| `seed-evaluator.ts` | 184 | 12-criterion seed quality scoring |
| `growth-tips.ts` | 215 | Genre-aware YouTube algorithm boost tips |
| `watchdog.ts` | 259 | Pooled worker-thread wall-clock timeouts |
| `graceful-shutdown.ts` | 132 | Shared SIGTERM/SIGINT handler with per-task 15s timeout |
| `tracing.ts` | 68 | OpenTelemetry NodeSDK init (auto + Prisma) |
| `http-transport.ts` | 123 | Global undici dispatcher (socket-level timeouts) |
| `sse-dedup.ts` | 120 | Distributed SSE connection dedup via Redis pub/sub |
| `sanitize.ts` | 217 | `sanitizeAIResponse`, JSON repair |
| `sanitize-prompt.ts` | 33 | User-input prompt sanitization |
| `word-count-compliance.ts` | 194 | Pad/trim to word-count band |
| `timing.ts` | 130 | Narration timing constants |
| `retry.ts` | 45 | Jittered exponential backoff |
| `create-redis.ts` | — | Factory with DNS lookup bypass |
| `shared-redis.ts` | 48 | Single ioredis singleton |
| `health-server.ts` | 106 | Worker `/health` & `/ready` HTTP server |
| `request-url.ts` | 35 | `getPublicBaseUrl(req)` honors `x-forwarded-host/proto` |
| `id-regex.ts` | 7 | UUID v4 or CUID regex |
| `job-ownership.ts` | 78 | SSE/status ownership resolver |
| `module-path.ts` | 45 | ESM-safe `__dirname`/`__filename` |
| `units.ts` | 73 | Branded numeric types (`Seconds`, `Milliseconds`, `Minutes`) |
| `sleep.ts` | 3 | Promise-wrapped `setTimeout` |

### 4.5 11-Stage Pipeline

**Driver** (`orchestrator.ts`, 839 lines) — fenced checkpoint keys `job:${jobId}${attempt? :attempt:N}:${key}`, stage-done flags with 2h TTL, candidate persistence (REL-005) before stage 5, refine loop with `QualityError` distinction, best-attempt publish.

**Pipeline entry** (`pipeline/index.ts`, 663 lines) — `runStoryPipeline` with preloaded-story shortcut, seed-quality eval, token-budget reservation, watchdog, refine loop, DLQ override.

| Stage | File | Behavior | AI calls |
|-------|------|----------|----------|
| **1** | `stage1-uniqueness.ts` (63) | DB-scan uniqueness + `avoidanceConstraints` | 0 |
| **2** | `stage2-blueprint.ts` (138) | Blueprint with in-flight claim conflict retry (max 3) | 1–2 |
| **3** | `stage3-character-bible.ts` (109) | Protagonist with role-uniqueness guard; fallback to `defaultCharacterBible` | 1 (4 retries) |
| **4** | `stage4-world-bible.ts` (75) | Antagonist + supporting + environments + per-genre archetype fallback | 1–2 |
| **5** | `stage5-episodes.ts` (313) | Pass 1 episode meta (sequential) + Pass 2 parallel scenes + cross-episode dedup + word-count compliance + duration clamp 50–60s | 10–20 |
| **6** | (built into index.ts) | Story assembly with cached counts | 0 |
| **7** | `stage7-humanization.ts` (383) | Per-scene rewrite + cross-scene repetition detection | varies |
| **8** | `stage8-quality.ts` (181) | LLM judge + deterministic penalty deductions | 1 |
| **9** | `stage9-seo.ts` (102) | SEO via `generateYouTubeSEO()` with 3-min watchdog + default fallback | 1 |
| **10** | `stage10-copyright-sweep.ts` (127) | 3-tier filter with genre-aware hard redaction | 0 |
| **11** | `stage11-embedding.ts` (110) | pgvector embedding (best-effort, 90s watchdog) | 0 (embedding endpoint) |

**Stage 5 detail:** Pass 1 sequentially generates episode meta (each N depends on N-1's `episodeSummary` + `cliffhanger`); Pass 2 generates scenes in parallel via `Promise.all`, each with prior-openings dedup context; `deduplicateCrossEpisodeScenes` rotates genre fallbacks for over-similar scenes; `ensureEpisodeWordCompliance` pads/trims to band.

**Stage 7 detail:** `humanization/index.ts` (281 lines) implements rhythm-based AI detection — sentence-start variety, length variance, transition density, low-score sentence indices. Sends targeted rewrite prompts for low-scoring sentences.

**Stage 8 detail:** `quality-judge.ts` builds a digest of the story, asks the LLM for 12 sub-scores, validates the schema, retries up to 3 times with JSON repair. `quality/index.ts` (152 lines) adds deterministic penalty engine (repetition/structure/continuity).

**Stage 9 detail:** `startWatchdog({timeoutMs: 180_000, label: 'stage9_SEO'})`. SEO defaults to `getDefaultYouTubeSEO()` with `isPlaceholder:true` internal flag.

**Stage 10 detail:** Three tiers: copyright (IP), hard-safety (slurs/sexual/impersonation — always block), monetization (advertiser-unfriendly). Genre-sensitive safety (`suicide`, `heroin`) allowed in horror/dark-fantasy via `redactGenreSensitiveSafetyTerms` — replaces with `[redacted]` in synopsis + narration.

**Stage 11 detail:** `startWatchdog({timeoutMs: 90_000, label: 'stage11_embedding'})` — best-effort: if embedding fails, story still completes.

**Refine loop** (`pipeline/index.ts`):
- Throws `QualityError` (typed) on threshold miss
- Reads `quality_floor` from `system_settings`
- Max 2 retries (`humanization_story_quality_retries`)
- On exhaustion: best-effort publish — skip stages 9–11

**Candidate persistence** (`saveInterimCandidate`): writes partial story state to Redis between stages so partial stalls can resume.

**Checkpoint keys** (H7 fenced): `job:${jobId}${attempt? :attempt:N}:${key}` — prevents cross-job bleed and cross-attempt race.

### 4.6 HTTP Routes (`backend/src/routes/`)

| File | Lines | Endpoints |
|------|-------|-----------|
| `auth.ts` | 400 | `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/me` |
| `stories.ts` | 615 | CRUD: list/get/patch/delete, episode+scene patches, export backup |
| `generation.ts` | 525 | `/stories/generate` (POST), status, full-state, episode/scene/full regen |
| `events.ts` | 488 | SSE `/events` (HMAC), `/status`, `/refresh-auth`, Last-Event-ID replay |
| `export.ts` | 335 | `/stories/:id/export` (json/csv/txt/ssml/srt/vtt) |
| `similarity.ts` | 164 | `/stories/check-similarity` GET |
| `settings.ts` | 381 | `/settings` CRUD (system + user), batch + DELETE |
| `user-settings.ts` | 181 | `/user-settings` per-user CRUD |
| `admin.ts` | 808 | `/admin/queue`, `/admin/dlq`, `/admin/settings/timing`, `/admin/settings/pipeline`, `/admin/stats`, `/admin/cleanup-test-users` |
| `openapi.ts` | 1170 | OpenAPI 3.1 spec + Redoc UI at `/api/docs` |
| `metrics.ts` | 97 | `/metrics` Prometheus export |
| `health.ts` | 80 | `/health` (DB + Redis ping) |
| `alerts.ts` | 122 | `/alerts/alerts` Alertmanager webhook (HMAC token) |
| `public-config.ts` | 37 | `/public-config` (genres, MAX_SEED_LENGTH, registration flag) |

**Auth endpoints details:**
- `register` — bcrypt 10-14 rounds, timing-safe invite compare, advisory xact lock for "first user is admin" race
- `login` — dummy bcrypt hash for nonexistent users (constant-time ~237ms)
- `logout` — blacklists jti in Redis with remaining TTL
- `refresh` — rotates jti, revalidates against DB user, blacklists old token
- `me` — re-checks blacklist

**Stories endpoints:**
- Cursor pagination (sortBy: newest/oldest/title)
- Status state machine (failed→draft only via API)
- Episode+scene PATCH with optimistic version lock
- `episodeCount`/`sceneCount` cached at save time

**Generation endpoints:**
- `POST /generate` returns HMAC-signed SSE URL in 202 response
- `GET /:storyId/generation-status` — job ownership check
- `GET /:jobId/full-state` — job ownership check
- `PATCH /:storyId/episodes/:episodeNumber` — optimistic version
- `PATCH /:storyId/episodes/:episodeNumber/scenes/:sceneNumber` — optimistic version
- `POST /:storyId/regenerate` — extended socket timeout (15 min)

**Events endpoints:**
- `GET /:jobId/events` — SSE with HMAC verification, Last-Event-ID resume
- Per-conn 50 events/sec queue, 15-min activity timeout, 2-hour hard ceiling
- Dedicated dedup subscriber
- `GET /:jobId/refresh-auth` — issue new HMAC for existing owner
- `GET /:jobId/status` — HMAC or JWT path

**Export endpoints:**
- 6 formats: JSON, CSV, TXT, SSML, SRT, VTT
- 4 content options: full, prompts-only, voiceover-only, scenes-only
- CSV: XML-entity escaping + formula-prefix injection guard (tab-prefix `=`, `+`, `-`, `@`)
- SSML/SRT/VTT: XML entity encoding
- Ownership verification + CSRF on POST

**Admin endpoints:**
- `GET /admin/queue` — queue + DLQ depth, today's completed, recent failures
- `POST /admin/queue/:jobId/restart` — DLQ retry, preserves userId/webhookUrl/storyId
- `GET /admin/settings/timing` + `PATCH` — cross-field refines (min ≤ max)
- `GET /admin/settings/pipeline` + `PUT /:key` — per-key type/range
- `GET /admin/dlq`, `POST /dlq/:jobId/requeue`, `DELETE /dlq/:jobId`
- `GET /admin/stats`
- `POST /admin/cleanup-test-users` — 3 req/min, audited

**Similarity endpoints:**
- `GET /stories/check-similarity?genre=...&seed=...` — duplicate concept detection
- `GET /stories/:id/similarity` — scene similarity matrix
- `GET /stories/:id/confidence` — quality confidence scores
- `GET /stories/:id/regeneration-history` — edit/regen audit trail

**Settings endpoints:**
- `GET /settings`, `GET /settings/:key`, `PUT /settings/:key`, `PUT /settings` (batch), `DELETE /settings/:key`
- `GET /user-settings`, `PUT /user-settings`

### 4.7 Middleware (`backend/src/middleware/`)

| File | Lines | Purpose |
|------|-------|---------|
| `error.ts` | 113 | `AppError`, `errorHandler`, `asyncHandler`, `asyncMiddleware` |
| `api-auth.ts` | 194 | `apiAuthMiddleware`, SSE HMAC verification (`verifySSEAuth`, `verifySSEAuthForJob`) |
| `admin.ts` | 117 | `verifyAdminAuth` (ADMIN_API_KEY, JWT admin, blacklist check) |
| `csrf.ts` | 248 | Double-submit (XSRF-TOKEN cookie + X-CSRF-Token header, timing-safe) |
| `jwt.ts` | 251 | HS256 JWT signing, blacklist (Redis), `jwtMiddleware`, `JWT_COOKIE_OPTIONS` |
| `rate-limit.ts` | 417 | Redis-backed: general/perUser/ai/register/login/session/export/stories/health/jobs |
| `request-id.ts` | 45 | `requestIdMiddleware`, `requestLogger` (HMAC-redacting) |
| `story-ownership.ts` | 19 | `verifyStoryOwnership` (userId match or role=admin) |
| `validate-params.ts` | 44 | Per-segment UUID/CUID validation |

### 4.8 Database Layer (`backend/src/database/`)

| File | Lines | Purpose |
|------|-------|---------|
| `prisma.ts` | 90 | Lazy PrismaClient factory, PgBouncer mode, connection-limit clamping |
| `prisma-storage.ts` | 14 | Re-export barrel |
| `prisma-storage/builder.ts` | 203 | `buildStoryCreateData`, `isStoryInput` |
| `prisma-storage/read.ts` | 242 | `getAllStories`, `getStoryById`, `getStoryForExport`, `getStoriesForSimilarity` |
| `prisma-storage/write.ts` | 444 | `createStory`, `updateSceneNarration`, `updateEpisodeMeta`, `updateStory`, `deleteStory`, `replaceStoryAtomically`, `cleanupOrphanedGenerationLogs` |
| `prisma-storage/converters.ts` | 223 | DB-row → domain `Story/Episode/Scene/Character/Environment` |
| `prisma-storage/validation.ts` | 144 | `DuplicateStoryError`, `DuplicateSeoTitleError`, `ProtagonistNameCollisionError`, `validateStoryInvariants`, `validateEmbedding` (1024-dim) |

**`createStory` invariants:**
- Serializable transaction (protagonist-name race-free)
- `checkSeoTitleDuplicate` (pg_trgm)
- P2002 target-aware → `DuplicateStoryError`
- `deduplicationKey` if `forceNew=true` appends unique nonce

**`validateStoryInvariants` checks:**
- Episode count
- Scene count
- Duration 50–60s
- ≥120-char pairs dedup
- Trigram count

**`validateEmbedding`:**
- 1024-dim
- Finite components only
- Validates pgvector casting safety

### 4.9 Background Workers (`backend/src/queue/workers/`)

| File | Lines | Purpose |
|------|-------|---------|
| `run-worker.ts` | 338 | Standalone worker: health-server thread, metrics server, story/background workers, periodic cleanup |
| `story.worker.ts` | 342 | BullMQ adapter: translates `Job<StoryJobData>` → `runStoryPipeline`, post-pipeline verify, webhook, DLQ |
| `worker-factory.ts` | 163 | `createStoryWorker` lock/stall/backoff config, DLQ wiring |
| `worker-metrics.ts` | 146 | prom-client Registry + AI hooks |
| `metrics-server.ts` | 68 | Worker `/metrics` HTTP server |
| `job-lifecycle.ts` | 73 | `observeJobStarted/Retry/Terminal/Failed` metrics |
| `background-seo.worker.ts` | 163 | `processSeoJob` + `createBackgroundSeoWorker` |
| `background-embedding.worker.ts` | 154 | `processEmbeddingJob` + `createBackgroundEmbeddingWorker` |

**Periodic cleanup** (`run-worker.ts`):
- `q.clean(3600_000, 1000, 'completed')` — drop completed jobs > 1h
- `q.clean(86400_000, 1000, 'failed')` — drop failed jobs > 24h
- 24h `setInterval` with `unref()`

**Worker concurrency:** `WORKER_CONCURRENCY=2` (default).

**Worker rate limit:** 10 jobs per 60s.

**Worker ports:**
- `:3001` — health endpoint (workder-thread)
- `:3002` — Prometheus metrics

---

## 5. Frontend Deep-Dive

The frontend is a Next.js 16.2 App Router application using React 19. It contains **42 production files + 16 test files** totaling ~8,500 LOC.

### 5.1 Routing Tree

```
app/layout.tsx → QueryProvider → AuthProvider → AppShell
├── (dashboard)/layout.tsx → RequireAuth (302→/login when unauthed)
│   ├── / (DashboardHeader + StatsGrid + StoryGrid + LazyGenerationModal)
│   ├── /create (genre + seed + SSE progress + preview)
│   ├── /history (sortable/filterable/paginated)
│   ├── /story/[id] (Server Component → story-detail-client with tabs)
│   │   └── /episode/[episodeId] (per-episode view)
│   ├── /settings (Server Component + interactive settings-client)
│   └── /admin (admin-only: health, queue, DLQ, restart jobs)
├── /login, /register (AppShell minimal mode for unauthed)
├── /api/[...path] (BFF proxy to Express)
└── not-found.tsx
```

**No dedicated `loading.tsx` per route** — only the global `app/error.tsx`.

**Public auth route bypass** (`app-shell.tsx:22-29`): `PUBLIC_AUTH_ROUTES = new Set(['/login', '/register'])` renders a minimal shell (no sidebar/top-nav) for unauthenticated pages.

**Hybrid SSR/CSR split:**
- `story/[id]/page.tsx` and `settings/page.tsx` are **Server Components** that forward cookies via `serverApiFetch` to seed initial data, then defer interactivity to `*-client.tsx` files.

**Permanent redirect** (`next.config.ts:74-77`): `/dashboard` → `/` (308).

### 5.2 BFF Proxy (`app/api/[...path]/route.ts`, 339 lines)

A **Backend-for-Frontend** catch-all that forwards every `/api/*` request to Express so the browser never talks to Express directly (no CORS, internal URL stays server-side).

**Pipeline:**

1. **Path/method allowlist** — `ALLOWED_PATHS` with regex patterns per allowed origin:
   - `/api/auth(/.*)?` — GET, POST, DELETE
   - `/api/stories/generate/:id/(events|status|refresh-auth)` — GET
   - `/api/stories(/.*)?` — GET, POST, PUT, PATCH, DELETE
   - `/api/admin(/.*)?` — all methods
   - `/api/settings(/.*)?` — GET, PATCH, DELETE
   - `/api/user-settings(/.*)?` — GET, PUT, DELETE
   - `/api/health(/.*)?` — GET
   - `/api/public-config(/.*)?` — GET
   - `isAllowedPath` selects the longest (most specific) regex match.

2. **Target URL** — `${API_BASE_URL}${pathname}${search}`. `getApiBaseUrl()` throws if missing → 503.

3. **Header sanitization** — builds a fresh `Headers` object:
   - Allows: `content-type`, `accept`, `accept-language`, `x-csrf-token`, `x-request-id`, `cookie`
   - `authorization` **only if** it parses as a valid Bearer JWT (regex `JWT_REGEX`)
   - Sets trusted `x-forwarded-proto`, `x-forwarded-for` (from `X-Real-IP` then direct IP, fallback `'unknown'`), `x-forwarded-host` from `req.nextUrl.host`
   - Explicitly **deletes** `host`

4. **Body parsing** — for non-GET/HEAD with `application/json`: reads raw text first (handles bodyless POSTs), validates JSON, returns 400 on invalid, otherwise `JSON.stringify(JSON.parse(raw))`. Other content types pass through as text.

5. **Timeout** — default 300s (5 min); SSE extends to 7200s (2 hr); configurable via `PROXY_TIMEOUT_MS`.

6. **SSE branch** — if `accept` or `content-type` is `text/event-stream`, wraps the upstream `ReadableStream` in a new stream with abort propagation, 502 on null body.

7. **Error handling** — abort → 504; config error → 503; other → 502.

### 5.3 State Management

**Zustand store** (`lib/stores/app-store.ts`):

```ts
useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  searchQuery: '',
  filterGenre: null,
  toasts: [],
  toggleSidebar, setSearchQuery, setFilterGenre,
  addToast, removeToast
}))
```

- `addToast` **deduplicates** identical messages (line 49)
- Caps array at 25 (line 54)
- `makeId()` uses `crypto.randomUUID()` with `Math.random()` fallback

**TanStack Query** (`lib/query/`):

```ts
new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5*60*1000, gcTime: 30*60*1000, retry: 2, refetchOnWindowFocus: false }
  }
})
```

**Query keys:**

| Key | Hook | Endpoint | Stale time |
|-----|------|----------|------------|
| `['stories','infinite', search, genre, sortBy]` | `useInfiniteStories` | `/api/stories?limit=20&...` | 30s |
| `['stories','recent']` | `useRecentStories` | `/api/stories?limit=3` | 2 min |
| `['story', id]` | `useStory` | `/api/stories/:id` | 5 min |
| `['stories','count']` | `useStoryCount` | `/api/stories?limit=1` | 2 min |

**Mutations:**
- `useDeleteStory` — invalidates `infinite/recent/count`, removes `['story', id]`
- `useRegenerateStory` — invalidates all four keys, plus specifically `['story', oldStoryId]`
- `useRegenerateEpisode` / `useRegenerateScene` — invalidates `['story', storyId]`

### 5.4 Auth Flow

**Login page** (`app/login/page.tsx`):
- Flash banner via `useSyncExternalStore` (hydration-safe)
- Validates `?from=` to start with `/` but not `//`
- Wrapped in `<ErrorBoundary>`

**Registration page** (`app/register/page.tsx`):
- Fetches `/api/public-config` on mount to detect `registrationDisabled`
- Validations: username 3-30 chars `[a-zA-Z0-9_]`, password 8-128 chars, 4-of-6 strength criteria
- Optional `inviteCode` field

**JWT cookie handling:**
- Server sets `access_token` (httpOnly) and `XSRF-TOKEN` (readable by JS)
- All `apiFetch` calls use `credentials: 'include'`
- CSRF double-submit: `lib/utils/api.ts:138` attaches `X-CSRF-Token` only on POST/PUT/PATCH/DELETE
- BFF proxy at `app/api/[...path]/route.ts:166` forwards `cookie` + `x-csrf-token` headers

**Auth context** (`lib/auth/auth-context.tsx`, 226 lines):
- Bootstrap on mount: GET `/api/auth/me`
- If 401: try `/api/auth/refresh`, then re-`/me`
- Then every ~14 minutes (`REFRESH_INTERVAL_MS`), or sooner if login was > 13 min ago (`REFRESH_EARLY_AFTER_MS`)
- On 401/403 from refresh → logout. On 5xx → exponential backoff 1s→60s cap
- `bootstrappedRef` prevents React StrictMode double-bootstrap

**Route protection** (`lib/auth/require-auth.tsx`):
- Renders nothing while loading
- If not authenticated and not loading, `useEffect` pushes `router.push('/login?from=' + pathname)`

**Logout** (`useAuth().logout()`):
- DELETE `/api/auth/logout` via `apiFetch`
- Finally `setUser(null)` (try/finally to ensure logout even if API throws)

### 5.5 Component Library

**UI primitives** (`components/ui/`):
- `<Button>` — `forwardRef` button: `primary|secondary|ghost|danger` × `sm|md|lg` + `isLoading`
- `<Modal>` — accessible dialog: focus trap, scroll lock, escape, framer entrance
- `<ToastContainer>` — assertive (errors) + polite (success/info) live regions; 5 max, 5s auto-dismiss

**Layout** (`components/layout/`):
- `<AppShell>` — skip-link, mobile header, top-nav, sidebar, mobile-nav, main, toasts
- `<TopNav>` — logo, links (Dashboard/Create/History), stats badge, user menu
- `<Sidebar>` — nav, quick-genres, recent stories
- `<MobileNav>` / `<MobileHeader>` — bottom nav + top bar (md:hidden)

**Dashboard** (`components/dashboard/`):
- `DashboardHeader`, `StatsGrid`, `SearchFiltersBar`, `StoryGrid`, `StoryCard`, `StoryCardSkeleton`, `EmptyState`
- `<GenerationModal>` — genre radios, seed textarea, `GenerationProgressView` step list

**Generation** (`components/generation/`):
- `<GenreSelector>` — 21 motion.genre buttons with shared `layoutId`
- `<SeedInput>` — textarea + collapsible example seeds
- `<GenerationPreview>` — story preview card with metadata + first 5 episodes

**Story** (`components/story/`):
- `<StoryHeader>` — title, dates, Export/Regenerate/Delete buttons
- `<StoryOverviewTab>` — scores, quality grade, full narration, episode cards
- `<StoryPromptsTab>` — compact/verbose copy button, prompt list
- `<StorySeoTab>` — YouTube SEO display
- `<EpisodeCard>` — clickable + regenerate side button (avoids nested-button HTML invalidity)
- `<SceneRow>` — intensity badge, image/video/narration prompts, copy + regenerate
- `<InlineEditor>` — click-to-edit field with `expectedVersion` optimistic-lock PATCH

**Error boundary** (`components/error-boundary.tsx`):
- Class component, dev-mode stack trace, reload button

### 5.6 Custom Hooks

**`hooks/use-generation.ts`** (587 lines) — the SSE-with-polling-fallback story-generation orchestrator:

```ts
useGeneration(options?: {
  onStart?: () => void;
  onProgress?: (p: GenerationProgress) => void;
  onSuccess?: (s: Story) => void;
  onError?: (msg: string) => void;
}): {
  generate: (opts: { genre: Genre[]; seed?: string; forceNew?: boolean }) => Promise<void>;
  reset: () => void;
  isGenerating: boolean;
  progress: GenerationProgress | null;
  error: string | null;
  generatedStory: Story | null;
  jobId: string | null;
}
```

**State and refs (8+):**
- `isGenerating`, `progress`, `error`, `generatedStory`, `jobId`
- `eventSourceRef`, `reconnectTimeoutRef`, `reconnectCountRef`, `reconnectJobIdRef`
- `optsRef`, `sseFailedRef`, `sseFailedAtRef`, `pollingIntervalRef`
- `connectToSSERef` (TDZ workaround for recursive reconnect)
- `generationIdRef` (FE-002 staleness guard)
- `inflightPostRef`/`inflightPostPromiseRef` (Fix #39 cancel)
- `sseAuthRef` (HMAC for URL-bound auth)
- `isGeneratingRef` (H8 in-flight guard)
- `isMountedRef`

**Internal helpers:**
- `buildSSEUrl(id)` — appends `?auth=...&t=...` if `sseAuthRef` exists
- `startPollingFallback(pollJobId)` — `setInterval(5000)` hitting `/api/stories/generate/:id/status`; aborts after `NEXT_PUBLIC_MAX_SSE_POLL_MS` (default 60 min)
- `connectToSSE(id)` — `useCallback` (line 202). Creates `EventSource`, wires `onopen`/`onmessage` (handles `connected`/`heartbeat` no-ops, `progress`, `complete`, `error`), `onerror` (closes, fetches `/status`, schedules reconnect with exponential backoff `3000 * 2^n` capped at 30000ms + jitter; after `MAX_RECONNECT_ATTEMPTS = 5` flips to `sseFailedRef` and starts polling fallback)

**`generate` callback** (line 414) — guards via `isGeneratingRef.current` (H8), bumps `generationIdRef`, sets initial state, cancels in-flight POST (Fix #39), POSTs to `/api/stories/generate` via `apiFetchWithCancel`, stores HMAC `sseAuth`, then `connectToSSERef.current(newJobId)`.

**Constants:**
- `MAX_RECONNECT_ATTEMPTS = 5`
- `POLL_INTERVAL_MS = 5000`
- `DEFAULT_MAX_POLL_MS = 60 * 60 * 1000`

**`useAuth()`** — exposes `{ user, isAuthenticated, isLoading, login, logout, setUser }`.

---

## 6. Data Model (`backend/prisma/schema.prisma`)

**11 models** (10 tables + enums):

### Story (aggregate root)
- `id` (UUID PK), `title`, `genre`, `seed?`, `theme?`, `status` (FSM)
- `userId` (required, FK Restrict on User)
- `deduplicationKey` (unique)
- `embedding: Float[]` default `[]` — 1024-dim pgvector (partial HNSW index via raw SQL)
- `episodeCount?`, `sceneCount?` (cached at save time)
- `qualityScore?`, `qualityGrade?`
- `seedStoryId?` (self-FK to Story, SetNull on delete)
- `youtubeTitle`, `youtubeDescription`, `youtubeTags`, etc. — vestigial columns declared in schema to prevent Prisma drift after migration to `YouTubeSEO` table
- Indexes: HNSW partial on embedding (1024-dim), `@@index([userId])`, `@@index([status])`

### YouTubeSEO (1:1 with Story)
- `storyId @unique` (cascade delete)
- `title` (≤100 chars), `description`, `tags: JSON`
- `thumbnailSuggestions: JSON`, `videoTemplate`, `hookScript`, `algorithmBoostTips: JSON`
- `viralPotential: 0–100`, `recommendedDuration`, `targetAudience`
- `trendingKeywords: JSON`, `ctaScript`

### Episode
- `id`, `storyId` (FK cascade), `number`, `title`, `hook`, `cliffhanger`, `synopsis`
- `voiceoverText?`, `musicSuggestions?`, `soundDesign?`
- `duration: 50–60s`
- `version` (optimistic locking)
- `@@unique([storyId, number])`

### Scene
- `id`, `episodeId` (FK cascade), `storyId` (denormalized for FK trigger), `number`
- `narrationText`
- `imagePromptContent`, `videoPromptContent`
- `cameraType` (8-value enum)
- `duration: 10–12s`
- `version`
- `@@unique([episodeId, number])`, `@@index([storyId])`

### Character
- `id`, `storyId` (FK cascade), `name`, `role` (narrowed runtime), `gender`
- `appearance`, `personality`, `speechPatterns`, `relationships`, `catchphrases`
- `@@index([storyId])`

### Environment
- `id`, `storyId` (FK cascade), `name`, `type`
- `description`, `timeOfDay`, `weather`, `mood`
- `lightingSetup: JSON` (validated to `LightingSetup`)

### GenerationLog
- `id`, `storyId` (SetNull FK), `episodeId?`, `sceneId?`, `userId?`
- `action` enum: `story_planning|episode_meta|episode_scene|character_bible|youtube_seo|retry|fallback|validation_failed|regeneration|scene_regeneration|story_edit`
- `details: JSON`, `createdAt`, `updatedAt`
- `@@index([storyId, createdAt])`

### UserSettings
- `id`, `userId` (default `'global'`), `key`, `value`
- `type: enum(string|number|boolean|json)`, `updatedAt`
- `@@unique([userId, key])`

### SystemSettings
- `id`, `key @unique`, `value`, `type`, `updatedAt`

### AuditLog
- `id`, `action` enum: `CREATE|UPDATE|DELETE|LOGIN|LOGOUT|REGENERATE`
- `entityType` enum: `story|episode|scene|user|setting|webhook|bulk`
- `entityId`, `before: JSON`, `after: JSON`, `userId`, `createdAt`
- `@@index([entityType, entityId])`

### User
- `id`, `username @unique`, `passwordHash`, `role` (default `'user'`)
- `createdAt`, `updatedAt`

**Key invariants:**
- `Story.userId` non-nullable + `Restrict` FK (migration 20260627000000)
- Embedding validated 1024-dim finite-only
- HNSW index requires raw SQL migration (`prisma migrate deploy`, never `db push`)
- `GenerationLog` FKs cascade `SetNull` to preserve audit history

**30 migrations** spanning 2026-05-21 to 2026-07-31 covering:
- Bible/template fields
- Version + indexes
- Quality + recommendations
- System settings
- pgvector + HNSW
- pg_trgm extension
- Users table
- FK constraints + per-user settings
- Default user role
- Story deduplication key
- Audit remediation
- Metadata score columns
- Synthetic user role fixes

---

## 7. Security Posture

### Network Layer (Caddy)
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `-Server` (removes Server header)
- `X-Forwarded-*` overwrites (prevents HMAC host poisoning)

### Backend Hardening
- Helmet with strict CSP (no inline scripts)
- Per-request CSP nonce for `/api/docs` only (CRIT-14)
- CORS allowlist
- JSON depth limit (32)
- URI cap 2048 on `/api/stories/generate`
- CIDR-allowlist `/metrics` (loopback + RFC1918)
- `x-powered-by` disabled, `trust proxy=1`

### Authentication
- **HS256 JWT** (`middleware/jwt.ts`) — `access_token` cookie (httpOnly, SameSite=strict) + `XSRF-TOKEN` (readable by JS)
- **Redis blacklist** with remaining TTL on logout
- **JWT_SECRET** separate from API_SECRET (privilege separation)
- Dummy bcrypt hash for nonexistent users (constant-time ~237ms)
- First-user admin with advisory xact lock

### Authorization
- **CSRF double-submit** (`middleware/csrf.ts`) — `X-CSRF-Token` header must equal `XSRF-TOKEN` cookie (timing-safe compare)
- **SSE HMAC-SHA256** (`middleware/api-auth.ts`) — `hmacSha256(API_SECRET, jobId:timestamp)`
- **Admin auth** (`middleware/admin.ts`) — `ADMIN_API_KEY` Bearer OR admin-role JWT
- **API_SECRET** never grants admin access (privilege-separated)
- **Story ownership** (`middleware/story-ownership.ts`) — userId match or role=admin

### Rate Limiting
- Redis-backed `express-rate-limit`:
  - General: 100/min per IP
  - Auth: 10/min per IP
  - Per-user
  - AI generation (separate)
  - Jobs/SSE (separate)
  - Export, admin (60/min)
  - Cleanup test users (3/min)

### Content Filtering (`lib/copyright-filter.ts`, 635 lines)

**3-tier system:**

| Tier | Check | Behavior |
|------|-------|----------|
| **Copyright** | Exact + leetspeak (`0→o, 1→i, 3→e, 4→a, 5→s, 7→t, $→e, @→a, !→i`) + Levenshtein ≤1 (≥5 chars) + negation context | Redact |
| **Safety** | Slurs + sexual + impersonation (hard) | Always block |
| **Monetization** | Advertiser-unfriendly terms | Warn |

**Genre-aware safety** — `suicide`/`heroin` allowed in horror/dark-fantasy via `redactGenreSensitiveSafetyTerms` (replaces with `[redacted]` in synopsis + narration).

**Sub-tiers:**
- `FUZZY_TERMS` — only variants different from base, ≥5 chars
- `HARD_SAFETY_CHECK_REGEXES` (genre-sensitive excluded)
- `NEGATION_WORDS` 48-char lookbehind
- `isNegatedContext` — last 4 words must be negation

### Input Validation
- Zod schemas on every request
- HTML tag detection for story fields
- State machine for `status` transitions
- Bounds checking for episode/scene numbers

### SSRF Protection (`services/webhook.ts`, 399 lines)
- URL blocklist
- Single-label hostname reject
- IPv4-mapped IPv6 reject
- DNS-rebind TOCTOU protection via IP-pinned undici dispatcher
- 3 retries
- No redirect

### Token Budget (`services/token-budget.ts`, 1083 lines)
- **Lua atomic** `ATOMIC_CHECK_AND_USE_WITH_BREAKDOWN` (daily/monthly + prompt/completion sub-keys)
- `RESERVE_LUA` (idempotent pre-charge per job)
- `REFUND_LUA` (EXISTS-checked DECRBY to prevent negative)
- `RECONCILE_LUA` (estimate vs actual)
- RedisHash-based CB with in-memory fallback
- LRU eviction
- Per-job charge-source tracking

### Frontend Security
- CSP nonce per request
- BFF proxy header sanitization
- `authorization` only Bearer JWT (regex-validated)
- Trusted `x-forwarded-*` set explicitly

### In-Process Worker Hardening
- Production refuses to start with `RUN_WORKER_INPROCESS=true`
- Worker separate container in production

### Secret Management
- All secrets on disk (mode 600/700), mounted at `/run/secrets/*`
- Never in env vars (prevents `docker inspect` leak)
- `bootstrap_first_user_admin` requires explicit opt-in
- 27 placeholder patterns rejected
- `API_SECRET` per-process random in dev (insufficient for multi-replica)

---

## 8. Observability

### Logging
- **Library**: Pino (JSON prod, pretty dev)
- **Request ID**: `X-Request-ID` header injected on every request for log correlation
- **Redaction**: `REDACT_PATHS` for credentials
- **Key events**: request start/end, job enqueue/complete, AI requests, auth failures

### Tracing
- **OpenTelemetry NodeSDK** + auto-instrumentations + Prisma
- OTLP endpoint → Jaeger (`jaegertracing/all-in-one:1.50`)

### Metrics
- **Endpoint**: `GET /metrics` (CIDR-allowlisted)
- **Library**: prom-client
- **Custom metrics**:
  - HTTP request count/duration
  - Story generation count/duration
  - AI token usage (per provider, per status)
  - Queue depth
  - DLQ depth
  - Job lifecycle (started, retry, terminal, failed)

### Logs Aggregation
- Promtail → Loki (multi-tenant via `X-Scope-OrgID`) → Grafana
- Drop rules for health check noise (`/api/health`, `/metrics`, `/api/docs`)

### Alerts (8 rules in `prometheus/alerts.yml`)

| Alert | Expression | Severity |
|-------|------------|----------|
| `BackendDown` | `up{job="backend"} == 0` for 1m | critical |
| `WorkerDown` | `up{job="worker"} == 0` for 1m | critical |
| `HighErrorRate` | 5xx rate > 5% over 5m for 2m | warning |
| `RedisMemoryHigh` | memory > 85% for 5m | warning |
| `QueueDepthHigh` | story-gen > 10 for 5m | warning |
| `DLQDepthHigh` | any DLQ > 5 for 5m | warning |
| `AIRequestsFailing` | increase failures > 5 over 10m for 2m | warning |
| `TokenBudgetExceeded` | increase rejected > 0 over 10m for 1m | warning |

### Backend Health
- `/api/health` returns `{ success, data: { status, database, redis, timestamp } }`
- Worker has `/health` and `/ready` endpoints (worker_thread)
- Graceful shutdown: SIGTERM → `server.close()` + `prisma.$disconnect()` + Redis quit

---

## 9. Deployment & Infrastructure

### `docker-compose.yml` (578 lines) — Local Dev Stack

13 services on 2 networks (`default` + `internal:true`):

| Service | Image | Resources | Healthcheck |
|---------|-------|-----------|-------------|
| postgres | `pgvector/pgvector:pg16` | 1.0/512M, 0.25/128M | `pg_isready` + SELECT 1 |
| redis | `redis:7-alpine` | 0.5/256M, 0.1/64M | `redis-cli ping` |
| jaeger | `jaegertracing/all-in-one:1.50` | 1.0/2048M, 0.25/256M | — |
| migrations | build `./backend` | 0.25/256M, 0.05/64M | init-only |
| backend | build `./backend` | 1.0/512M, 0.25/128M | `curl /api/health` |
| worker | build `./backend` | 1.5/1024M, 0.5/512M | `curl /health` |
| frontend | build `.` | 0.5/512M, 0.1/128M | `wget frontend:3000` |
| prometheus | `prom/prometheus:v2.53.0` | 1.0/1024M, 0.25/256M | — |
| redis-exporter | `oliver006/redis_exporter:v1.66.0-alpine` | 0.1/32M | — |
| alertmanager | build `deploy/alertmanager/Dockerfile` | 0.25/128M, 0.05/32M | — |
| loki | `grafana/loki` | 0.5/512M, 0.1/128M | — |
| promtail | `grafana/promtail` | 0.25/128M, 0.05/128M | — |
| grafana | `grafana/grafana` | 0.5/256M, 0.1/64M | — |

**YAML anchors:**
- `x-shared-env` — `NODE_ENV=production`, `ALLOW_INSECURE_LOCAL_HTTP=true`, AI URLs, `WORKER_CONCURRENCY=2`, `DB_CONNECTION_LIMIT=10`
- `x-app-hardening` — `security_opt: [no-new-privileges]`, `cap_drop: [ALL]`

**Volumes (7 named):** `postgres_data`, `redis_data`, `prometheus_data`, `alertmanager_data`, `loki_data`, `grafana_data`

**Secrets (12 file-based):** All from `./secrets/<file>` mounted at `/run/secrets/*`:
- `database_url`, `redis_url`, `api_secret`, `jwt_secret`, `admin_api_key`
- `postgres_password`, `redis_password`, `mistral_api_key`, `kimi_api_key`
- `grafana_admin_password`, `alert_receiver_token`, `loki_tenant_id`

### `docker-compose.prod.yml` (181 lines)

Adds **Caddy** service (`caddy:2-alpine`, ports 80/443) with auto-TLS.

Locks down backend:
- `DISABLE_REGISTRATION=true` (default)
- `INVITE_CODE=<strong random>`
- `ALLOW_INSECURE_LOCAL_HTTP=false`
- Cost caps: `MAX_STORIES_PER_DAY=10`, `AI_DAILY_SPEND_CAP_USD=10`, `AI_MONTHLY_SPEND_CAP_USD=100`, `AI_DAILY_TOKEN_BUDGET=100000`, `AI_MONTHLY_TOKEN_BUDGET=1000000`

Removes host ports from all internal services.

### `docker-compose.e2e.yml` (28 lines)

Sets `E2E_TEST=true`, `STORY_TEST_MODE=canned`, `ALLOW_E2E_IN_PRODUCTION=true` — required because base runs `NODE_ENV=production`. Critical comment: "These vars must NEVER be in `docker-compose.yml`'s shared-env because shell env var substitution can leak them."

### `Dockerfile` (Frontend, 76 lines)

**Multi-stage:**
- `base`: `node:20-alpine` digest-pinned; `NEXT_TELEMETRY_DISABLED=1`
- `deps`: `npm ci --frozen-lockfile`
- `builder`: Defense-in-depth check (fails if `/app/.env` or `/app/secrets` exist); `npx next build`
- `runner`: chown `.next/standalone/`, `.next/static/`, `public/`, `scripts/`, `tmp/`, `.next/cache/` (Fix #50); non-root `nextjs` user; HEALTHCHECK via `node -e "fetch(...)"`; ENTRYPOINT `docker-entrypoint.sh`

### `deploy/`

| File | Purpose |
|------|---------|
| `caddy/Caddyfile` (78) | Caddy v2 reverse-proxy with auto-TLS + security headers |
| `alertmanager/Dockerfile` (14) | Build Alertmanager image (digest-pinned) |
| `alertmanager/entrypoint.sh` (101) | Substitute runtime secrets into `alertmanager.yml` |
| `backup/backup-postgres.sh` (273) | Daily PG backup with 30-day retention, encryption, restore verification, S3 |
| `backup/backup-redis.sh` (200) | Daily Redis RDB backup with same pipeline |
| `backup/cinematicai-backup.cron` (28) | Cron schedule (3 AM UTC PG, 3:30 AM UTC Redis) |
| `grafana/entrypoint.sh` (42) | Generates Grafana datasource provisioning with Loki tenant |
| `loki/loki-config.yml` (41) | Loki server config with multi-tenant auth |
| `loki/promtail-config.yml` (65) | Promtail shipping Docker JSON logs to Loki |
| `redis/redis-aof-guard.sh` (48) | Repairs torn AOF before Redis starts (M71) |

### `scripts/`

| File | Lines | Purpose |
|------|-------|---------|
| `check-build-artifacts.js` | 89 | Verifies committed build artifacts match fresh `npm run build` |
| `check-secrets.sh` | 82 | Pre-commit secret scanner (4 checks + gitleaks) |
| `ci-local.js` | 43 | Mirrors GitHub Actions CI locally |
| `docker-entrypoint.sh` | 57 | Frontend container entrypoint: writes `/runtime-config.js` |
| `generate-secrets.sh` | 141 | Generates cryptographically-random secrets (mode 600) |
| `sync-version.mjs` | 51 | Syncs version to `backend/package.json` + lock |
| `test-migrations.mjs` | 52 | Migration integrity check: `migrate deploy` + `migrate diff` |
| `wait-for-stack.js` | 68 | Cross-platform wait for Docker stack readiness |

### `secrets/`

12 Docker secret files (mode 600): `admin_api_key`, `alert_receiver_token`, `api_secret`, `database_url`, `grafana_admin_password.txt`, `jwt_secret`, `kimi_api_key`, `loki_tenant_id`, `mistral_api_key`, `postgres_password`, `redis_password`, `redis_url`.

---

## 10. CI/CD Pipeline

### `.github/workflows/ci.yml` (610 lines)

**Triggers:** push to main/master, PR, workflow_dispatch.
**Concurrency:** `${{ workflow }}-${{ ref }}` with `cancel-in-progress: true`.

**Jobs (sequential then parallel):**

1. **`commitlint`** (PR only) — conventional commits
2. **`migration-test`** — pgvector service, `node scripts/test-migrations.mjs`
3. **`schema-audit`** — docker-compose services, `npm run test:schema`
4. **`hnsw-index`** — same setup, `npm run test:hnsw`
5. **`backend`** — install, prisma generate, typecheck, typecheck:all, lint, build, artifact freshness, npm audit, SAST, TruffleHog, Trivy FS, unit tests, upload
6. **`frontend`** — install, typecheck, typecheck:test, unit tests, lint, npm audit, TruffleHog, build, artifact freshness, upload
7. **`e2e`** (needs backend + frontend) — pgvector + redis services, migrations, start stack, Playwright Chromium, `--grep-invert 'integration'`
8. **`integration-tests`** (needs backend) — schema audit, start backend + worker, run integration specs
9. **`validate-prod-env`** — Node inline script asserting `validateAndLoadEnv` rejects placeholders
10. **`quality-gate`** (final aggregator, `if: always()`) — allows commitlint `skipped`, fails on any other non-success

### `.github/workflows/release.yml` (72 lines)

- **Trigger:** `workflow_run` for `CI` with type `completed`, branch `main`
- **Conditions:** only proceeds if `workflow_run.conclusion == 'success'`
- **Steps:** checkout, npm ci, git config, `standard-version --dry-run`, conditional `npm run release` + push, conditional `gh release create`

### `.github/workflows/security.yml` (183 lines)

- **Triggers:** push to main, PR, weekly Sunday, workflow_dispatch
- **Jobs:**
  - `zap-scan` — ZAP baseline + API scan with custom rules
  - `trivy-scan` — SARIF on backend + frontend images
  - `sbom-provenance` — npm SBOM (SPDX) + docker buildx SBOM/provenance

### `.github/CODEOWNERS` (31 lines)

Default + per-path rules. Note: `@maintainers` is a placeholder; replace with real team before enabling branch protection.

---

## 11. Testing Strategy

### Backend Unit (Vitest)
~50 test files covering:
- Pipeline orchestrator (839-line target)
- Copyright filter (3 tiers)
- Rate-limit matrix
- JWT concurrent
- CSRF matrix
- All services

### Backend Integration (Vitest)
8 files:
- `token-budget-race`
- `story-worker`
- `schema-sync`
- `hnsw-dim`
- DB isolation invariants
- ESLint plugin tests
- OpenAPI route coverage

### Backend E2E (Vitest)
4 files:
- Chain integration
- Route contract
- Generation flow
- Alerts

### Frontend Unit (Vitest + RTL)
16 test files:
- All UI components (button, modal, toast)
- `use-generation` (479 lines, 13 tests + 2 sub-describes)
- `auth-context` (6 scenarios)
- `require-auth` (single-redirect guard)
- Login flash banner
- Modal focus management
- a11y smoke (axe-core: Modal/Button/Toast have zero critical/serious violations)
- Generation modal X button vs minimize button
- Genre selector (all 21)
- Story header (UTC locale)

### Playwright E2E
4 specs:
- `api.spec.ts` — SSE/contract, helpful tests for the actual SSE flow
- `story-generation.spec.ts` — full browser flow with mocked APIs
- `story-worker.integration.spec.ts` — full BullMQ pipeline
- `token-budget-race.integration.spec.ts` — Redis Lua atomic check

### Vitest Configuration

```ts
{
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./test/setup.ts'],
  // ...
  coverage: { thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 } }
}
```

### Test Setup (`test/setup.ts`, 65 lines)
- `@testing-library/jest-dom/vitest` matchers
- `crypto.getRandomValues` + `randomUUID` polyfills
- `IntersectionObserver`, `window.matchMedia`, `scrollTo`, `ResizeObserver` mocks

---

## 12. Custom Tooling

### `eslint-plugins/test-quality.mjs` (679 lines)

Custom ESLint plugin `eslint-plugin-cinematicai-test-quality` enforcing test-quality guardrails from the 2026-06-28 test audit.

**7 rules:**

| Rule | Severity | Purpose |
|------|----------|---------|
| `no-trivial-assertions` | error | Banned: `toBeDefined`, `toBeTruthy`, `toExist` (allows `.not.toBeDefined()`) |
| `click-needs-assertion` | error | Every `user.click`/`userEvent.click`/`fireEvent.click` must have an `expect()` AFTER |
| `test-against-project-middleware` | error | Bans direct import of `express-rate-limit` in tests |
| `no-module-level-process-env` | error | Flags module-level `process.env.X` reads (allows `NODE_ENV`, inside functions, or PERMISSIVE_FILES) |
| `no-redundant-button-onkeydown` | error | Flags `<button onKeyDown>` handling Enter/Space (browser already fires onClick) |
| `prefer-genre-map` | warn | Flags `GENRES.find(g => g.value === ...)` — should use `GENRE_MAP[genre]` |
| `no-local-imported-function-collision` | warn | Flags module-scope local function/const with same name as imported binding |

### Default Husky Hooks

- `pre-commit` — `secret-scan.sh`
- `commit-msg` — `commitlint`
- `pre-push` — `npm run lint && npm run typecheck && npm test`

### `eslint.config.mjs` (147 lines)

ESLint 9 flat config with `eslint-config-next`, custom plugin, and strict rules.

### `commitlint.config.mjs`

Conventional commits enforcement.

### `vitest.config.ts`, `playwright.config.ts`, `postcss.config.mjs`

Per-tool configuration.

---

## 13. Key File Reference

### Highest-signal files (most understanding per line)

| File | Lines | Why |
|------|-------|-----|
| `backend/src/services/types.ts` | 253 | Canonical domain types |
| `backend/src/server.ts` | 636 | Express bootstrap, middleware ordering, HNSW checks |
| `backend/src/lib/ai-client.ts` | 1321 | AI abstraction, circuit breaker, rate limit, SEO |
| `backend/src/queue/workers/pipeline/orchestrator.ts` | 839 | 11-stage driver, checkpoints |
| `backend/src/queue/workers/pipeline/index.ts` | 663 | Pipeline entry, retry/refinement, watchdog |
| `backend/src/lib/copyright-filter.ts` | 635 | 3-tier content filtering |
| `backend/src/services/token-budget.ts` | 1083 | Lua atomic budget |
| `backend/src/lib/episode-generator.ts` | 1995 | Stage 5 episode/scene generation |
| `backend/src/routes/admin.ts` | 808 | Admin queue/DLQ/settings/stats |
| `backend/src/routes/openapi.ts` | 1170 | OpenAPI 3.1 + Redoc UI |
| `app/api/[...path]/route.ts` | 339 | BFF proxy |
| `hooks/use-generation.ts` | 587 | SSE orchestrator |
| `lib/auth/auth-context.tsx` | 226 | Refresh loop + bootstrap |
| `docker-compose.yml` | 578 | Full local stack |
| `next.config.ts` + `proxy.ts` | 80 + 335 | CSP nonce, security headers |
| `eslint.config.mjs` | 147 | ESLint flat config |
| `prisma/schema.prisma` | — | Canonical data model |

### File counts by area

| Area | Files |
|------|-------|
| Backend source | 54 |
| Backend tests | ~50 |
| Frontend source | 42 |
| Frontend tests | 16 |
| Prisma + migrations | 31 |
| Deploy | 10 |
| CI/CD | 3 |
| Scripts | 8 |
| E2E | 4 |
| ESLint plugins | 2 |
| Secrets | 12 |
| Config (root) | ~15 |
| **Total tracked** | ~250 |

---

## 14. Notable Architectural Decisions

1. **Caddy → BFF proxy → Express** — Browser never talks to Express directly. CSP scoped per-request nonce (no static `unsafe-inline`).

2. **Candidate persistence before stage 5** (REL-005) — Partial stalls can resume from Redis checkpoints.

3. **REGEN-FAST pre-seed** — Reconstructs checkpoint from persisted Story to skip stages 1–4 on regeneration.

4. **AOF repair guard** (`deploy/redis/redis-aof-guard.sh`) — Prevents Redis crash-loops after unclean shutdowns.

5. **Secrets as files** — `secrets/` directory (mode 600/700) → `/run/secrets/*` → never in env vars → never visible in `docker inspect`.

6. **In-process worker** for dev only (`RUN_WORKER_INPROCESS=true`); production always separate container.

7. **JWT blacklisting in Redis** — `SET blacklist:jti EX <remaining_ttl>` on logout.

8. **Backoff-bounded circuit breaker** — 60s → 120s → ... → 30min max, Promise-mutex probe prevents thundering herd in half-open.

9. **Quality refine loop** — Max 2 retries with `QualityError` distinction from infra errors; best-effort publish path skips stages 9–11 on exhaustion.

10. **Genre-aware content filter** — Horror/dark-fantasy can mention `suicide`/`heroin` (genre-sensitive safety); but hard-coded slurs/exploitation always block.

11. **HNSW index requires raw SQL** — `prisma migrate deploy` includes raw SQL; `db push` would skip the index.

12. **Strict import order** — `tracing → http-transport → load-env → validateAndLoadEnv` enforced at runtime.

13. **Two networks** — `default` (public/monitoring) + `internal` (data plane, no outbound).

14. **E2E bypass gating** — `E2E_TEST`, `STORY_TEST_MODE=canned`, `ALLOW_E2E_IN_PRODUCTION` are gated by `NODE_ENV !== production` unless `ALLOW_E2E_IN_PRODUCTION=true`; required to be in `docker-compose.e2e.yml` (never in main).

15. **Caddy header overwrites** — `X-Forwarded-*` overwrites (not appends) to prevent HMAC-signed `sseUrl` host poisoning.

16. **Vestigial YouTube SEO columns** declared in schema — Prevents Prisma drift after migration to `YouTubeSEO` table.

17. **Vestigial `internal: true` docker network** — No outbound, no cross-network reach.

18. **pino-pretty in dev only** — JSON in production for log aggregation.

19. **HMAC SSE auth** — `API_SECRET` is multi-purpose (SSE HMAC + webhook signing) but never grants admin access (privilege-separated).

20. **CSRF double-submit** — `XSRF-TOKEN` cookie (readable by JS) + `X-CSRF-Token` header on mutations; timing-safe compare.

---

## 15. Known Tech Debt (from README)

| Issue | Impact | Workaround |
|-------|--------|------------|
| In-process worker (dev default) | Worker crashes affect API server | Set `RUN_WORKER_INPROCESS=false` in production |
| Single Redis pub/sub subscriber | SSE stalls if Redis connection dies | Frontend falls back to HTTP polling |
| CSRF cookie not httpOnly | XSS could read CSRF token | Ensure no XSS vulnerabilities in frontend |
| DB pool default 10 | Adequate for current scale; tunable via `DB_CONNECTION_LIMIT` | Raise only under measured connection contention |

---

## 16. Production Checklist (from README)

- [ ] Set `NODE_ENV=production`
- [ ] Set real `API_SECRET` and `ADMIN_API_KEY` (not dev fallbacks)
- [ ] Set `RUN_WORKER_INPROCESS=false` for process isolation
- [ ] Configure `DATABASE_URL` accessible from container
- [ ] Configure `REDIS_URL` accessible from container
- [ ] Set `CORS_ORIGIN` to your frontend domain
- [ ] Bind backend to `0.0.0.0` (not `localhost`) for Docker networking

---

*End of analysis.*
