# syntax=docker/dockerfile:1.7
# Build context: repository root (docker build -f apps/api/Dockerfile .)
FROM node:24-alpine AS base
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

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/healthz >/dev/null || exit 1
CMD ["sh", "-c", "node dist/migrate.mjs && exec node --enable-source-maps dist/server.mjs"]
