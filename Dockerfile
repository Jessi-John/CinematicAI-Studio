# Frontend — Next.js production image
#
# Fix #50: chown runtime directories to the `nextjs` user. The previous
#   build left them owned by root (the default for the build stage), but
#   the runtime stage runs as `nextjs` (UID 1001). At runtime, some npm
#   packages — notably those that cache to `.cache/` or write sourcemaps
#   — fail with EACCES because they cannot write to
#   `node_modules/<pkg>/.cache/`. Adding `--chown=nextjs:nodejs` on the
#   `COPY` lines resolves the issue at build time, so the runtime user
#   already owns the directories it needs to write to. We rely on the
#   Next.js standalone output's own `node_modules` instead of copying the
#   full development tree, which keeps the image small and the build fast.
#
# Fix #49: mirror the CSP/headers set in next.config.ts at the
#   reverse-proxy layer (not added here — this Dockerfile only produces
#   the image; the headers come from next.config.ts via the standalone
#   server).

# LOW #66: Pin base images by digest for reproducible, tamper-resistant builds.
FROM node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Defense in depth: .env and secrets/ are dockerignored, but fail the build
# fast if they ever leak into the build context. Runtime secrets are injected
# via Docker secrets / environment variables, never baked into the image.
RUN if [ -f /app/.env ] || [ -d /app/secrets ]; then \
      echo "FATAL: .env or secrets/ found in build context — check .dockerignore"; \
      exit 1; \
    fi

# Runtime config: API_BASE_URL is injected at container start by
# scripts/docker-entrypoint.sh. The build-time NEXT_PUBLIC_API_URL is
# no longer needed — the entrypoint writes the actual URL to
# public/runtime-config.js before Next.js starts.
RUN npx next build
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Fix #50: chown EVERY directory the nextjs user will need to write to.
# This includes the standalone bundle, the static assets, AND the
# public dir — even though the latter is read-only at runtime, a future
# `next build` (e.g. when running with a different output mode) would
# fail without write access.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy entrypoint script for runtime config injection
COPY --from=builder --chown=nextjs:nodejs /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000

# MEDIUM #69: In-image healthcheck so orchestrators can detect a hung
# frontend without relying solely on compose-level configuration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000)).then(r => { if (!r.ok) throw new Error('status '+r.status); process.exit(0); }).catch(() => process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]
