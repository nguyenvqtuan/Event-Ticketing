# Event Ticketing

A seat reservation and ticketing platform. This repository is a pnpm + Turborepo
monorepo holding a NestJS API and a Next.js web client.

> Status: **TICK-11** done. Scaffold, configuration, domain model, Docker image,
> Postgres schema, index audit, event/seat endpoints, the concurrent seat-hold
> flow, optimistic locking, reservation expiry and idempotent payments are all
> working and verified end to end against a live database.

**Start here:** [`docs/domain.md`](docs/domain.md) — aggregates, invariants,
bounded contexts and the Reservation/Order state machines.
[`docs/db.md`](docs/db.md) — the schema, the double-booking constraint, and the
expand/contract migration strategy.
[`docs/indexing.md`](docs/indexing.md) — query plans, index justifications, and
the partial index that measurement rejected.
[`docs/concurrency.md`](docs/concurrency.md) — how holds avoid overbooking:
locking, isolation level, and deadlock avoidance.

## Layout

```
apps/
  api/                    NestJS API      (port 3000)
    src/inventory/          bounded context: events, seats, reservations
    src/payment/            bounded context: orders, double-entry ledger
    src/shared/domain/      shared kernel: Money, DomainError
    src/health/             liveness + readiness
    src/config/             validated configuration
  web/                    Next.js client  (port 3001)
packages/
  tsconfig/               shared TypeScript configs (base / nest / next)
  eslint-config/          shared ESLint flat configs (base / nest / next)
docs/
  domain.md               the domain model
  db.md                   schema, constraints, migration strategy
  indexing.md             query plans and index justifications
  concurrency.md          locking, isolation level, overbooking
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

Database commands are API-scoped and need `DATABASE_URL`:

| Command                                | What it does                                 |
| -------------------------------------- | -------------------------------------------- |
| `pnpm --filter @repo/api db:migrate`   | Apply pending migrations                     |
| `pnpm --filter @repo/api db:rollback`  | Revert the most recent                       |
| `pnpm --filter @repo/api db:status`    | Show applied vs pending                      |
| `pnpm --filter @repo/api db:reset`     | up → down all → up (exercises the down path) |
| `pnpm --filter @repo/api db:generate`  | Regenerate SQL from `schema.ts`              |
| `pnpm --filter @repo/api db:seed:perf` | Load 120k seats for performance work         |
| `pnpm --filter @repo/api db:explain`   | EXPLAIN ANALYZE the hot queries              |

Turborepo caches `build`, `lint`, `typecheck` and `test`, so repeat runs that
touch nothing are near-instant.

## Running with Docker

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

**Requires BuildKit** (`docker buildx`). The `deps` stage uses a
`--mount=type=cache` for the pnpm store, which the legacy builder cannot parse —
it fails with _"the --mount option requires BuildKit"_. Compose uses BuildKit by
default; a bare `docker build` on an older setup may need `DOCKER_BUILDKIT=1`.

Runtime image is **303 MB** on `node:24-alpine`, containing no TypeScript
toolchain and no dev dependencies.

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

### API endpoints

| Endpoint                                 | Purpose                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `POST /events`                           | Create an event and generate its seat inventory, in one transaction |
| `GET /events/:id`                        | Event details plus derived seat counts (available/held/sold)        |
| `GET /events/:id/seats?status=AVAILABLE` | Seats filtered by derived availability, paginated                   |

`POST /events` accepts an optional `Idempotency-Key` header. Repeating a request
with the same key replays the stored response instead of creating a second
event; reusing a key with a different body returns `409`.

Seat generation is separately idempotent: seat codes are unique per event, so
re-generating inserts only what is missing (`ON CONFLICT DO NOTHING`). The two
mechanisms cover different failures — a retried request that would create a
duplicate _event_, and a re-run generation that would create duplicate _seats_.

Request bodies are validated with Zod; invalid payloads return `400` listing
every offending field at once.

**Holding seats is the contended path.** When N requests race for the same seat
exactly one wins and the rest get `409` — enforced in Postgres, not in process
memory, so it holds across instances. Seat rows are locked with `FOR UPDATE` in
seat-id order (deterministic, so overlapping multi-seat holds cannot deadlock),
under `READ COMMITTED`, with TICK-5's exclusion constraint as the backstop.
Verified with 20 concurrent holds: 1 × `201`, 19 × `409`, one live claim in the
database.

**Changing reservation state is the uncontended path**, so it uses optimistic
locking instead: `WHERE id = ? AND version = ?`, zero rows affected → `409`.
Only the holder cancels their own hold, so taking a lock on every request would
tax all of them to defend against something that almost never happens.
Both strategies, and the rule for choosing between them, are in
[`docs/concurrency.md`](docs/concurrency.md).

**Holds expire without anything having to run.** A claim covers its seat only
while `valid_during` contains `now()`, so a lapsed hold frees its seat the
instant the TTL passes — no sweeper, no write. A `@Cron` sweeper does run every
30s, but purely as bookkeeping: it moves `PENDING → EXPIRED` so the stored state
stops lying and dead rows leave the indexes. It fires on every replica and
claims batches with `FOR UPDATE SKIP LOCKED`, which also means a reservation
mid-payment is skipped rather than expired underneath it.

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
grep -rE "from '(@nestjs|typeorm|prisma|drizzle|pg)" apps/api/src \
  | grep -E "/(domain|application)/"
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
