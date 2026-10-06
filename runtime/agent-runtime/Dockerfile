# syntax=docker/dockerfile:1.7
# PubliEXPE Commercial OS - Agent Runtime (API + BullMQ worker)
# Build context: runtime/agent-runtime/

ARG NODE_VERSION=22-alpine

# ---- base: node + pnpm (via corepack, version pinned by packageManager) ----
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- build: full deps + tsc ----
FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    RUNTIME_ROLE=all \
    RUNTIME_HOST=0.0.0.0 \
    RUNTIME_PORT=4020 \
    RUN_MIGRATIONS=true
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
USER node
EXPOSE 4020
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RUNTIME_PORT||4020)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are idempotent (drizzle journal); disable with RUN_MIGRATIONS=false when several replicas start at once.
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = \"true\" ]; then node dist/db/migrate.js || exit 1; fi; exec node dist/main.js"]
