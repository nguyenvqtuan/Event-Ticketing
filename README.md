# Event Ticketing

A seat reservation and ticketing platform. This repository is a pnpm + Turborepo
monorepo holding a NestJS API and a Next.js web client.

> Status: **TICK-3** code complete. Scaffold and validated configuration are
> working and tested; the Docker image and compose stack are written but not
> yet run against a daemon (see [Running with Docker](#running-with-docker)).
> There is no schema and no domain model yet — those arrive in TICK-4 to TICK-6.

## Layout

```
apps/
  api/     NestJS API      (port 3000)
  web/     Next.js client  (port 3001)
packages/
  tsconfig/        shared TypeScript configs (base / nest / next)
  eslint-config/   shared ESLint flat configs (base / nest / next)
```

A monorepo (rather than two repositories) so the API and the web client share
one TypeScript and lint configuration today, and shared domain types later.

## Requirements

- **Node >= 20.9** (developed on v24)
- **pnpm 11** — `corepack enable pnpm` (the version is pinned via the
  `packageManager` field, so corepack fetches the right one automatically)

## Getting started

```bash
corepack enable pnpm
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm dev
```

The `cp` is not optional — `DATABASE_URL` has no default, so the API exits
rather than start without it (see [Configuration](#configuration)).

`pnpm dev` runs both apps: the API on <http://localhost:3000> and the web client
on <http://localhost:3001>.

```bash
curl localhost:3000/ping   # {"status":"ok","uptimeSeconds":12}
```

## Commands

Every command runs from the repository root and fans out through Turborepo.
Append `--filter @repo/api` or `--filter @repo/web` to scope one app.

| Command          | What it does                            |
| ---------------- | --------------------------------------- |
| `pnpm dev`       | Run both apps in watch mode             |
| `pnpm build`     | Build both apps                         |
| `pnpm lint`      | ESLint across the workspace             |
| `pnpm typecheck` | `tsc --noEmit` across the workspace     |
| `pnpm test`      | API unit tests (Jest)                   |
| `pnpm test:e2e`  | API end-to-end tests (Jest + supertest) |
| `pnpm format`    | Rewrite files with Prettier             |

Turborepo caches `build`, `lint`, `typecheck` and `test`, so repeat runs that
touch nothing are near-instant.

## Running with Docker

> **Not yet verified on a running daemon.** The Dockerfile and compose file are
> written and `docker compose config` validates, but the image has not been
> built and `docker compose up` has not been run — no Docker daemon was
> available in the environment where this was authored. Expect to shake out
> small issues on first build. Tracked on TICK-3 (SCRUM-3).

Brings up the API and Postgres together, with the API running from the same
multi-stage image that would ship — not a dev server:

```bash
docker compose up --build
curl localhost:3000/ready   # {"ready":true,"dependencies":{"database":"up"}}
```

The build context is the **repository root**, not `apps/api` — a pnpm workspace
install needs the root lockfile and the linked packages:

```bash
docker build -f apps/api/Dockerfile -t event-ticketing-api .
```

Notes on the image:

- **Multi-stage.** Dependencies install from manifests alone in a `deps` stage,
  so that layer caches until a dependency actually changes.
- **`pnpm deploy --prod --legacy`** resolves workspace links into a real,
  self-contained `node_modules` and drops devDependencies. The runtime stage is
  then a plain copy of `node_modules`, `dist` and `package.json` — no pnpm, no
  TypeScript, no symlinks escaping the image.
- **Runs as the unprivileged `node` user** that `node:alpine` already provides.
- **`node` is PID 1** (exec-form `CMD`), so it receives `SIGTERM` directly and
  shuts the pool down cleanly.

### Health endpoints

The two are deliberately distinct, and compose healthchecks the right one:

| Endpoint     | Meaning                                        | Touches Postgres |
| ------------ | ---------------------------------------------- | ---------------- |
| `GET /ping`  | Liveness — is the process up?                  | No               |
| `GET /ready` | Readiness — can it serve traffic? `503` if not | Yes (`SELECT 1`) |

A failing readiness check should pull an instance out of rotation; a failing
liveness check should restart it. Conflating them turns a brief database blip
into a restart loop.

`api` waits for `db` via `condition: service_healthy` — the API validates config
and connects on boot, so racing Postgres would just produce a restart loop.

## Configuration

Every variable the API reads is declared in
[`apps/api/src/config/env.schema.ts`](apps/api/src/config/env.schema.ts) and
documented in [`apps/api/.env.example`](apps/api/.env.example). Nothing else
reads `process.env`.

| Variable                  | Default                 | Notes                                              |
| ------------------------- | ----------------------- | -------------------------------------------------- |
| `DATABASE_URL`            | **none — required**     | Must be a `postgres://` or `postgresql://` URL     |
| `NODE_ENV`                | `development`           | `development` \| `test` \| `production`            |
| `PORT`                    | `3000`                  | 1–65535                                            |
| `LOG_LEVEL`               | `log`                   | `error` \| `warn` \| `log` \| `debug` \| `verbose` |
| `RESERVATION_TTL_SECONDS` | `900`                   | Seat-hold lifetime; used from TICK-4               |
| `CORS_ORIGIN`             | `http://localhost:3001` | Browser origin allowed to call the API             |

Two properties are deliberate:

- **It fails fast.** Validation runs when `ConfigModule.forRoot({ validate })`
  is evaluated — during module import, before the HTTP server binds. Invalid
  config means the process exits `1`; it never serves traffic in a bad state.
  All problems are reported at once, not one per restart:

  ```
  Error: Invalid environment configuration:
    - PORT: Too big: expected number to be <=65535
    - LOG_LEVEL: Invalid option: expected one of "error"|"warn"|"log"|"debug"|"verbose"
    - DATABASE_URL: is required — see .env.example
  ```

- **`DATABASE_URL` has no default**, on purpose. A default would let a
  misconfigured deployment silently point at the wrong database — the one
  failure mode worth trading local convenience for.

Read config by injecting `AppConfigService`, which exposes parsed values
(`config.port` is a `number`, already coerced and range-checked):

```ts
constructor(private readonly config: AppConfigService) {}
```

## Architecture

NestJS modules map to bounded contexts, and each feature is split into four
layers with dependencies pointing **inward**:

```
interface  →  application  →  domain  ←  infrastructure
(HTTP)        (use cases)     (rules)     (adapters: DB, clocks, ...)
```

`src/health/` is a complete worked example of the pattern:

| Layer             | File                                       | Rule                                                                                             |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `domain/`         | `health-status.ts`, `health-probe.port.ts` | Plain TypeScript. No framework, no ORM, no I/O. Declares _ports_ (interfaces) for what it needs. |
| `application/`    | `check-health.use-case.ts`                 | Orchestrates the domain. Also framework-free — no `@Injectable()`.                               |
| `infrastructure/` | `process-uptime.probe.ts`                  | Adapters that implement a port. The only place the outside world is allowed in.                  |
| `interface/`      | `health.controller.ts`                     | Maps HTTP onto a use case. No business rules.                                                    |
| —                 | `health.module.ts`                         | Composition root. Binds the port to an adapter via a DI token.                                   |

Two consequences worth noting:

- **The domain never imports the ORM or DB driver.** When TICK-5 introduces
  Postgres, repositories follow the same shape as `HealthProbe`: an interface in
  `domain/`, an implementation in `infrastructure/`, bound in the module. The
  domain does not change.
- **Use cases are testable without Nest.** `check-health.use-case.spec.ts` uses
  a plain object as a fake probe — no DI container, no test module, no database.

You can check the rule holds at any time; this should print nothing:

```bash
grep -rE "from '(@nestjs|typeorm|prisma|drizzle|pg)" \
  apps/api/src/**/domain apps/api/src/**/application
```

## Toolchain notes

Two pins are deliberate and will look outdated if you only check "latest":

- **TypeScript is pinned to `6.0.3`, not 7.x.** `@nestjs/cli@12` depends on
  `typescript@~6.0.2`, `typescript-eslint` peers `<6.1.0`, and `ts-jest` peers
  `<7`. TypeScript 7 breaks linting and tests.
- **ESLint is pinned to `9.x`, not 10.x.** `typescript-eslint@8`'s scope manager
  does not implement the `addGlobals` API ESLint 10 calls, which crashes any
  config that declares globals. Revisit when typescript-eslint 9 ships.

**NestJS 12 is ESM-only**, so `apps/api` is an ESM package (`"type": "module"`).
Relative imports need explicit `.js` extensions — `./health.module.js`, even
though the file on disk is `.ts`. Jest therefore runs with
`NODE_OPTIONS=--experimental-vm-modules`.
