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
COPY packages/contracts/package.json packages/contracts/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @repo/api...

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY packages/ packages/
COPY apps/api/ apps/api/

# `@repo/api...` is the package AND its workspace dependencies, which pnpm runs
# in topological order — so @repo/contracts is compiled to the .d.ts files the
# API's controllers are typed against before `nest build` looks for them.
# Filtering to @repo/api alone leaves that dependency unbuilt.
RUN pnpm --filter "@repo/api..." run build

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

# Two hardening steps, both of which the CI scan gate would otherwise fail on:
#
#   - Patch OS packages the published base has not picked up yet. Alpine had
#     the fixed openssl before node:24-alpine was rebuilt with it, and waiting
#     on someone else's rebuild is not a vulnerability policy.
#   - Delete npm. This container runs `node dist/main.js` and never installs
#     anything, so the package manager bundled into the base is pure attack
#     surface — and its own dependencies (tar, brace-expansion, ip-address)
#     are what a scanner reports against an image that never calls them.
RUN apk --no-cache upgrade \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# node:alpine ships an unprivileged `node` user (uid 1000) — no need to create one.
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/package.json ./package.json

# Readiness compares the migrations this build ships against the ledger in the
# database, so the image carries them. They sit next to `dist`, at the same
# depth as in the source tree — which is how one relative path resolves in both.
COPY --from=build --chown=node:node /repo/apps/api/migrations ./migrations

# The runner too, so the deploy-time migration step uses the SAME artifact as
# the app it is migrating for (TICK-19). A separate migration image could drift
# from the SQL this one ships, and readiness would then report the disagreement
# as a half-done deploy. Node strips the types natively, so this needs no
# TypeScript at runtime, and `pg` is already a production dependency.
#
#   docker run --rm -e DATABASE_URL=... <image> \
#     node --experimental-strip-types scripts/migrate.ts up
#
# Only the runner: the other scripts here are performance tooling and have no
# business in a shipping image.
COPY --from=build --chown=node:node /repo/apps/api/scripts/migrate.ts ./scripts/migrate.ts

USER node
EXPOSE 3000

# Readiness, not liveness: this asserts the API reaches Postgres and that the
# schema matches the migrations this image ships.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly for graceful shutdown.
CMD ["node", "dist/main.js"]
