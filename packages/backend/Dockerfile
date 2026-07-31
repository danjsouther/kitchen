# Build from the monorepo root, not from this directory:
#   docker build -f packages/backend/Dockerfile -t recipes-backend .
# The root context is required so this stage can see the sibling
# packages/shared-types workspace, which the backend imports.

FROM node:24-bookworm-slim AS builder
WORKDIR /repo

# Manifests first, so a source-only change does not invalidate the npm ci layer.
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/backend/package.json packages/backend/package.json
RUN npm ci

COPY packages/shared-types packages/shared-types
COPY packages/backend packages/backend

# shared-types must be built first — the backend imports its compiled output,
# and `prisma generate` must run before the backend build because the generated
# client is compiled as part of it.
RUN npm run build -w packages/shared-types \
    && npm exec -w packages/backend -- prisma generate \
    && npm run build -w packages/backend

# Drops devDependencies. Note that `prisma` (the CLI) and `dotenv` are runtime
# dependencies on purpose: the entrypoint runs `migrate deploy`, which needs the
# CLI, and prisma.config.ts imports dotenv.
RUN npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# openssl is required by the Prisma CLI to detect libssl and pick the matching
# schema-engine binary; without it `migrate deploy` fails at startup.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 --create-home appuser

COPY --from=builder --chown=appuser:appuser /repo/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /repo/package.json ./package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/shared-types/package.json ./packages/shared-types/package.json

# The whole dist tree, not just dist/src: it also holds dist/generated (the
# compiled Prisma client, which src imports by relative path) and
# dist/prisma/seed (used by the entrypoint instead of tsx, which is pruned).
COPY --from=builder --chown=appuser:appuser /repo/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=appuser:appuser /repo/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder --chown=appuser:appuser /repo/packages/backend/prisma ./packages/backend/prisma
COPY --from=builder --chown=appuser:appuser /repo/packages/backend/prisma.config.ts ./packages/backend/prisma.config.ts

COPY --chown=appuser:appuser packages/backend/docker-entrypoint.sh /repo/docker-entrypoint.sh
RUN chmod +x /repo/docker-entrypoint.sh

# Recipe images are written here; docker-compose mounts a named volume over it
# so uploads survive a rebuild.
RUN mkdir -p /repo/packages/backend/uploads && chown appuser:appuser /repo/packages/backend/uploads

USER appuser
WORKDIR /repo/packages/backend
EXPOSE 3000
ENTRYPOINT ["/repo/docker-entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
