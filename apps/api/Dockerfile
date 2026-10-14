# syntax=docker/dockerfile:1.7
# Build context: repository root (docker build -f apps/api/Dockerfile .)
# Base image pinned by digest (Dependabot keeps it current); runtime and build share it
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/dns/package.json packages/dns/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @dit/api...
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# tsdown bundles the workspace packages and every dependency into dist/server.mjs and dist/migrate.mjs
RUN pnpm --filter @dit/api build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production PORT=3001
# The runtime only needs node: drop the package managers that ship with the image
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# Writes nothing to disk: can run with a read-only root filesystem
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/healthz >/dev/null || exit 1
CMD ["sh", "-c", "node dist/migrate.mjs && exec node --enable-source-maps dist/server.mjs"]
