# Roadmap

This roadmap describes the actual state of the repository and the work that is
planned next. Items are not commitments to a date or release. Completed items
are present in the codebase; planned items are not yet implemented.

## Completed

- Structured story-generation pipeline: blueprint, character bible, world
  bible, episodes, scenes, humanization, quality scoring, SEO, copyright sweep,
  embedding, and persistence.
- Character and environment continuity data carried into scene prompts.
- BullMQ background processing with SSE progress streaming and polling fallback.
- Single-episode and single-scene regeneration with optimistic locking and
  token-budget accounting.
- Atomic full-story regeneration.
- Story library with pagination, search, filtering, and JSON/CSV/TXT/SSML/SRT/VTT
  export.
- JWT cookie authentication, CSRF protection, admin API key authentication, and
  invite-only registration controls.
- Admin queue, dead-letter queue, settings, statistics, and OpenAPI endpoints.
- Quality, humanization, similarity, copyright, quota, and token-budget gates.
- Docker Compose development and production stacks, Docker secrets, health
  checks, and a Caddy TLS reverse proxy configuration.
- Prometheus metrics, structured logging, OpenTelemetry tracing, and Redis
  operational runbook.
- Frontend and backend Vitest suites, Playwright E2E suites, CI quality gates,
  migration tests, schema audits, and security scanning.
- Repository documentation: architecture diagrams, deployment guide, changelog,
  contribution guide, security policy, and issue/PR templates.
- Licensing: dependency audit completed (MIT, ISC, Apache-2.0, BSD-2-Clause;
  MPL-2.0 `axe-core` development-only) and the project released under the MIT
  License.

## In progress

- Documentation accuracy: keeping setup, environment, API, and deployment
  instructions aligned with the code and CI configuration.
- Expanding coverage of the remaining low-coverage areas, particularly the
  similarity route and the full scene-regeneration flow.

## Planned improvements

- Add an opt-in offline evaluation suite for prompt changes, as described in
  [`TODOS.md`](TODOS.md). It should score canned model output against curated
  golden responses before prompt-template changes merge.
- Add screenshots and short walkthroughs to the README once sanitized images
  are available.
- Continue dependency and base-image maintenance, including regular review of
  pinned Docker image digests and npm audit findings.
- Add more route-level tests for similarity, export edge cases, and admin
  recovery flows.
- Improve contributor onboarding with a first-issue list and a documented
  architecture walkthrough for new maintainers.
- Review accessibility of the dashboard, story, and settings flows with
  automated checks and manual keyboard testing.

## Long-term possibilities

These are exploratory ideas, not committed features:

- Pluggable AI provider adapters beyond the current Mistral/Kimi integration.
- Optional image and video generation integrations that consume the existing
  scene prompts.
- Multi-user collaboration and review workflows for story projects.
- Localization of the interface and generated metadata.
- Additional deployment targets (Kubernetes manifests, managed database
  guidance, object-storage exports).
- A versioned public API with generated client SDKs.
- Automated content-safety evaluation and human review queues.

## How to influence the roadmap

Open a feature request using the
[feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) and
describe the problem, proposed solution, and impact. Roadmap changes are made
at the maintainer's discretion.
