# Stage 1: Build dependencies and compile
# LOW #66: Pin base images by digest for reproducible, tamper-resistant builds.
FROM node:20-bookworm@sha256:cacf10e99285cbbc891452e31249c1b5ec3ba225f40028fae946b75aeaf1b66a AS builder

WORKDIR /app

# Install all dependencies (including dev) for build
COPY package*.json ./
# @prisma/client and prisma are pinned to exact matching versions (6.19.3)
# in package.json so --legacy-peer-deps is no longer needed.
RUN npm ci --frozen-lockfile

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript from source inside Docker
# (Windows filesystem cache is unreliable for Docker build context)
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Stage 2: Minimal production image
# Use Debian-based image for better Prisma binary compatibility (Alpine musl causes N-API issues)
FROM node:20-bookworm@sha256:cacf10e99285cbbc891452e31249c1b5ec3ba225f40028fae946b75aeaf1b66a AS runner

WORKDIR /app

# Install curl for healthcheck and OpenSSL 1.1 for Prisma schema engine
RUN apt-get update && apt-get install -y --no-install-recommends curl libssl3 && rm -rf /var/lib/apt/lists/*

# Copy entrypoint scripts BEFORE switching to non-root user
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY migrate-entrypoint.sh ./migrate-entrypoint.sh
RUN chmod +x docker-entrypoint.sh migrate-entrypoint.sh

# Copy production artifacts from builder.
# Copy FULL node_modules first, then prune to remove dev deps EXCEPT prisma
# CLI which is needed by the migration init container for `prisma migrate deploy`.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
# Keep prisma CLI (needed for migrations in entrypoint), remove other dev deps
RUN npm ls prisma --json 2>/dev/null | grep -q prisma && \
  cp -r node_modules/.bin/prisma /tmp/prisma-bin && \
  cp -r node_modules/prisma /tmp/prisma-pkg && \
  npm prune --production && \
  mkdir -p node_modules/.bin node_modules && \
  cp -r /tmp/prisma-bin node_modules/.bin/prisma && \
  cp -r /tmp/prisma-pkg node_modules/prisma && \
  rm -rf /tmp/prisma-bin /tmp/prisma-pkg || \
  npm prune --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/config/copyright-blocklist.json ./src/config/copyright-blocklist.json


# Non-root security — switch after entrypoint is set up
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:34567/api/health >/dev/null || exit 1

EXPOSE 34567
ENV NODE_ENV=production
ENV PORT=34567
ENV RUN_WORKER_INPROCESS=false

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]