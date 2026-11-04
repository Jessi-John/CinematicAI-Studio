# Contributing to CinematicAI Studio

Thanks for your interest in improving CinematicAI Studio. This guide covers the
development workflow and the checks a change must pass before review.

The project is licensed under the MIT License (see [`LICENSE`](LICENSE)).
Contributions are accepted under the same license; by opening a pull request
you confirm that you have the right to license the code you submit under MIT.

## Prerequisites

- Node.js 20 or newer
- npm (the repository uses `package-lock.json`; do not switch package managers)
- Docker with Docker Compose v2
- Git
- At least one AI provider key for manual story-generation testing:
  `MISTRAL_API_KEY` or `KIMI_API_KEY`

## Set up a development environment

1. Fork the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/<your-account>/CinematicAI-Studio.git
   cd CinematicAI-Studio
   git remote add upstream https://github.com/Jessi-John/CinematicAI-Studio.git
   ```

2. Create the local Compose configuration and secrets:

   ```bash
   cp .env.example .env
   bash scripts/generate-secrets.sh --write
   ```

   Add at least one AI provider key to `secrets/mistral_api_key` or
   `secrets/kimi_api_key` if you plan to run real generation. Never commit the
   `secrets/` directory.

3. Start the database and Redis:

   ```bash
   docker compose up -d postgres redis
   ```

   On Docker Desktop for Windows/macOS, services on the Compose internal
   network are not reachable through host port mappings. Use the full Docker
   stack or native PostgreSQL/Redis for host-process development; see
   [`DEPLOYMENT.md`](DEPLOYMENT.md).

4. Install and configure the backend:

   ```bash
   cd backend
   cp .env.example .env
   npm ci
   npx prisma generate
   npx prisma migrate deploy
   ```

   Set `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` in `backend/.env`. On
   Linux, the development Compose stack publishes PostgreSQL on host port
   15432 and Redis on 6379. Use the passwords generated in
   `secrets/postgres_password` and `secrets/redis_password`. Generate
   `JWT_SECRET` once with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   and reuse it in step 6. A host-run backend with `NODE_ENV=development` does
   not need `ALLOW_INSECURE_LOCAL_HTTP`.

5. Install the frontend:

   ```bash
   cd ..
   npm ci
   ```

6. Create `.env.local` at the repository root:

   ```dotenv
   API_BASE_URL=http://localhost:34567
   JWT_SECRET=<same 64-hex value used in backend/.env>
   ```

   The frontend proxy (`proxy.ts`) verifies session cookies at the edge, so a
   missing or mismatched value makes login appear to succeed and then bounce
   back to the login page.

## Run the application

Backend, from `backend/`:

```bash
npm run dev
```

The backend listens on <http://localhost:34567>. `backend/.env.example` sets
`RUN_WORKER_INPROCESS=true`, so the API also runs the worker in development. To
run the worker separately, set `RUN_WORKER_INPROCESS=false` and start it with:

```bash
cd backend
npm run worker
```

Frontend, from the repository root:

```bash
npm run dev
```

The frontend listens on <http://localhost:3000>.

## Run the checks

Run the same checks that CI runs before opening a pull request.

### Frontend (repository root)

```bash
npm run lint
npm run typecheck
npm run typecheck:all
npx vitest run
npm run build
```

### Backend (`backend/`)

```bash
npm run lint
npm run typecheck
npm run typecheck:all
npm test
npm run build
```

### End-to-end tests

The E2E suite requires the Docker stack and is slower than the unit suites:

```bash
npm run test:e2e
```

`test:e2e` starts the stack with the E2E override, waits for health checks, and
runs Playwright. The override sets `E2E_TEST=true`, `STORY_TEST_MODE=canned`,
and `ALLOW_E2E_IN_PRODUCTION=true`; it bypasses auth/CSRF/rate limits and
replaces AI calls with canned responses. It is scoped to `docker-compose.e2e.yml`
and must never be used in production. Run the secret setup in step 2 first,
because Compose still mounts the secret files.

CI uses ephemeral PostgreSQL and Redis service containers with fixed dummy
credentials. Pull-request checks do not require repository secrets. Never place
real credentials in workflow files or test fixtures.

## Code quality requirements

- TypeScript strict mode is enabled. Do not weaken `tsconfig.json` or
  `backend/tsconfig.json` to make a change compile.
- Keep ESLint clean. Fix warnings you introduce rather than suppressing them.
  If a suppression is genuinely required, scope it to one line and explain why.
- Follow the existing structure: routes in `backend/src/routes/`, services in
  `backend/src/services/`, shared helpers in `backend/src/lib/`, pipeline stages
  in `backend/src/queue/workers/pipeline/stages/`.
- Use the existing Prisma access pattern (`prisma()` as a function, not a
  module-level constant) and existing error helpers (`asyncHandler`,
  `AppError`).
- Validate new API input with Zod and return the existing API response shape.
- Add or update tests for behavior changes. Do not add tests that only assert
  a function was called; assert observable behavior.
- Update documentation and environment templates when you add configuration.
- Never commit `.env` files, `secrets/`, API keys, JWTs, or test artifacts that
  contain credentials.

## Branch naming

Use short, descriptive branches with a conventional prefix:

```text
feat/short-description
fix/short-description
docs/short-description
test/short-description
refactor/short-description
chore/short-description
```

Example: `fix/scene-regeneration-version-conflict`.

## Commit messages

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/).
Commitlint runs on pull requests and via the local commit-msg hook.

```text
feat: add scene-level regeneration audit entry
fix: reject expired session cookies on the BFF proxy
docs: document Docker secret generation
test: cover world-bible fallback behavior
```

Use `BREAKING CHANGE:` in the footer when a change is not backward compatible.

## Pull requests

Before opening a pull request:

1. Rebase on the latest `main` and resolve conflicts locally.
2. Run the frontend and backend checks listed above.
3. Confirm the production build succeeds.
4. Remove debug logging, temporary files, and generated artifacts.
5. Complete the pull request template, including the tests you ran.

Keep pull requests focused. A pull request that fixes a bug should not also
reformat unrelated files or upgrade dependencies. Describe:

- What changed and why.
- Any user-visible or API-visible behavior changes.
- How the change was tested.
- Any known limitations or follow-up work.

Link related issues with `Fixes #<number>` or `Refs #<number>`.

## Bug reports

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Include:

- A clear description of the problem.
- Reproduction steps.
- Expected and actual behavior.
- Environment details (operating system, Node.js version, Docker version,
  deployment method).
- Relevant logs with secrets and personal data removed.

Do not include API keys, JWTs, cookies, database URLs, or full `.env` files in
an issue. For security vulnerabilities, follow [`SECURITY.md`](SECURITY.md)
instead of opening a public issue.

## Feature requests

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
Describe the problem the feature solves, the proposed solution, alternatives
considered, and the expected impact. Feature requests are evaluated against the
project's scope; not every request will be accepted.

## API and documentation contributions

- The OpenAPI document lives in `backend/src/routes/openapi.ts`. When you add
  or change an endpoint, update the spec and the route tests.
- Keep the endpoint table in [`README.md`](README.md) consistent with the spec.
- Add new environment variables to `backend/.env.example` and
  `.env.example`, and document them in the README.
- Update [`CHANGELOG.md`](CHANGELOG.md) for user-visible changes.
- Keep examples runnable. Do not document commands that have not been verified
  against the repository.

## Review process

Maintainers review for correctness, security, test coverage, and consistency
with the existing architecture. Review may request changes; address feedback in
new commits and re-run the checks. Do not force-push over a review branch unless
the maintainer asks you to.

## License

By contributing, you agree that your contribution is distributed under the
project's [MIT License](LICENSE); see the
[License section of the README](README.md#license) for details.
