# Build from the monorepo root, not from this directory:
#   docker build -f packages/frontend/Dockerfile -t recipes-frontend .
# The root context is required so this stage can see packages/shared-types.

FROM node:24-bookworm-slim AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN npm ci

COPY packages/shared-types packages/shared-types
COPY packages/frontend packages/frontend

# shared-types is a real dependency of the app, not just types — the unit
# conversion and formatting logic is bundled into the browser build.
RUN npm run build -w packages/shared-types \
    && npm run build -w packages/frontend -- --configuration production


FROM nginx:1.27-alpine AS runtime

COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# The application builder emits into dist/frontend/browser; copying
# dist/frontend would put index.html one directory too deep and every route
# would 404.
COPY --from=builder /repo/packages/frontend/dist/frontend/browser /usr/share/nginx/html

EXPOSE 80
