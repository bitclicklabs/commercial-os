# syntax=docker/dockerfile:1.7
# PubliEXPE Commercial OS - pxos-renderer (Playwright + Chromium, JS rendering)
# Build context: services/renderer/
#
# The base image already ships Chromium and its system dependencies for EXACTLY the
# Playwright version pinned in package.json (1.63.0): keep both in sync.

ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble

# ---- base: node + pnpm (via corepack, version pinned by packageManager) ----
FROM ${PLAYWRIGHT_IMAGE} AS base
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

# ---- prod-deps: runtime dependencies only (no browser download: it is in the image) ----
FROM base AS prod-deps
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    RENDER_MAX_CONCURRENCY=2 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Non-root user shipped with the Playwright image.
USER pwuser
# Documentation only: the port is NOT published to the host (pxos-net only).
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
