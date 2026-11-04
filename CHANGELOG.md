# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `LICENSE` file releasing the project under the MIT License, with matching
  `license` fields in `package.json` and `backend/package.json`.
- `CONTRIBUTING.md` with development setup, quality checks, branch naming, and
  pull request guidance.
- `SECURITY.md` with private vulnerability reporting guidance, scope, and
  disclosure expectations.
- `ROADMAP.md` describing completed, in-progress, planned, and exploratory work.
- GitHub issue templates for bug reports and feature requests, plus a pull
  request template.
- Tests for world-bible generation, fallback behavior, environment
  deduplication, and character-continuity helpers.

### Changed

- Rewrote `README.md` with verified setup, environment, API, testing, Docker,
  troubleshooting, security, and contribution documentation.
- Documented the required `API_BASE_URL` and shared `JWT_SECRET` settings for
  local frontend development, corrected the Kimi/Mistral provider descriptions,
  and separated Docker Compose non-secret settings from host-run env files.
- Corrected the architecture pipeline order, auth cookie name, security posture,
  horizontal-scaling instructions, and Redis recovery commands.
- Updated Next.js to 16.4.5 and `undici` to 7.30.1, and applied compatible
  transitive dependency updates. Remaining high-severity production advisories
  require major upgrades tracked in `TODOS.md`.

### Fixed

- `typecheck:all` failures in frontend and backend test files.
- Test-quality invariant suites no longer depend on `fs.globSync`, which is
  unavailable in the supported Node.js 20 runtime and CI environment.
- CI now starts Docker Compose jobs with the secret files they require, runs
  frontend-only tests in the frontend job, validates the ESM environment module
  on Node.js 20, and no longer requires repository secrets for test jobs.
- E2E CI now passes the backend `JWT_SECRET` to the frontend server, so the
  edge proxy can verify session cookies.
- The production frontend uses a fixed internal `API_BASE_URL`, preventing a
  localhost value in `.env` from breaking the Docker stack.
- Redis receives the documented `REDIS_MAXMEMORY` setting, and telemetry uses
  the `cinematicai-*` service names.
- Tightened the prose-invariant allowlist to exact pattern names and removed
  stale file/allowlist entries.
- Removed the `__dirname` warning from the backend Vitest configuration.

## [1.0.0] - 2026-07-01

### Added

- Initial production release.
- GitHub release workflow (`.github/workflows/release.yml`) for automated
  version bumps from conventional commits.
- `CHANGELOG.md` following Keep a Changelog format.
- Version tags published to git on each release.

### Changed

- Version bumped from 0.1.0 to 1.0.0 (stable release).
