# syntax=docker/dockerfile:1

# Build context is the REPOSITORY ROOT, not apps/api — a pnpm workspace needs
# the root lockfile and the linked packages to install deterministically:
#   docker build -f apps/api/Dockerfile .

# ---- base -------------------------------------------------------------------
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# No TTY in a build: without CI, pnpm aborts rather than prompt before
# touching an existing modules directory.
ENV CI=true
RUN corepack enable pnpm
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
# Manifests only, so this layer is cached until a dependency actually changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @repo/api...

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @repo/api build

# `pnpm deploy` resolves workspace links into a real, self-contained
# node_modules and drops devDependencies — the runtime stage can then be a
# plain copy with no pnpm, no TypeScript and no symlinks pointing outside.
RUN pnpm deploy --filter @repo/api --prod --legacy /out

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# The API reads PORT from config; keep the default explicit for the healthcheck.
ENV PORT=3000

WORKDIR /app

# node:alpine ships an unprivileged `node` user (uid 1000) — no need to create one.
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/package.json ./package.json

# Readiness compares the migrations this build ships against the ledger in the
# database, so the image carries them. They sit next to `dist`, at the same
# depth as in the source tree — which is how one relative path resolves in both.
COPY --from=build --chown=node:node /repo/apps/api/migrations ./migrations

USER node
EXPOSE 3000

# Readiness, not liveness: this asserts the API reaches Postgres and that the
# schema matches the migrations this image ships.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "dist/main.js"]
