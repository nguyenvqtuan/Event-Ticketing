# Event Ticketing

A seat reservation and ticketing platform. This repository is a pnpm + Turborepo
monorepo holding a NestJS API and a Next.js web client.

> Status: **TICK-18** done. Scaffold, configuration, domain model, Docker image,
> Postgres schema, index audit, event/seat endpoints, the concurrent seat-hold
> flow, optimistic locking, reservation expiry, idempotent payments and the
> double-entry ledger, refunds-by-reversal, structured logging, the Terminus
> health probes, a Testcontainers-backed test foundation, an end-to-end
> purchase journey and a scanning CI pipeline are all working and verified end
> to end against a live database.

**Start here:** [`docs/domain.md`](docs/domain.md) — aggregates, invariants,
bounded contexts and the Reservation/Order state machines.
[`docs/db.md`](docs/db.md) — the schema, the double-booking constraint, and the
expand/contract migration strategy.
[`docs/indexing.md`](docs/indexing.md) — query plans, index justifications, and
the partial index that measurement rejected.
[`docs/concurrency.md`](docs/concurrency.md) — how holds avoid overbooking:
locking, isolation level, and deadlock avoidance.
[`docs/testing.md`](docs/testing.md) — the pyramid, the Testcontainers harness,
and what unit tests are allowed to know.
[`docs/runbook.md`](docs/runbook.md) — how to deploy, configure, smoke-test and
roll back, written for someone who did not build it.

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
    src/lib/api/            typed client: one method per endpoint, typed errors
    src/app/events/[id]/    smoke page — fetches and renders a real event
packages/
  contracts/              the HTTP contract, imported by BOTH apps
  tsconfig/               shared TypeScript configs (base / nest / next)
  eslint-config/          shared ESLint flat configs (base / nest / next)
docs/
  domain.md               the domain model
  db.md                   schema, constraints, migration strategy
  indexing.md             query plans and index justifications
  concurrency.md          locking, isolation level, overbooking
  testing.md              the pyramid, Testcontainers, coverage policy
  runbook.md              deploy, configure, smoke-test, roll back
```

Deploying is [`docs/runbook.md`](docs/runbook.md), and
`apps/api/scripts/smoke-test.sh <base-url> [--full]` is the post-deploy check it
ends on — read-only by default, `--full` to buy and refund a seat for real.

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
curl localhost:3000/healthz   # {"status":"ok","info":{"process":{"state":"ok",...}}}
```

## Commands

Every command runs from the repository root and fans out through Turborepo.
Append `--filter @repo/api` or `--filter @repo/web` to scope one app.

| Command          | What it does                             |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Run both apps in watch mode              |
| `pnpm build`     | Build both apps                          |
| `pnpm lint`      | ESLint across the workspace              |
| `pnpm typecheck` | `tsc --noEmit` across the workspace      |
| `pnpm verify`    | **Everything CI runs**, in one command   |
| `pnpm test`      | Unit tests — no database, under a second |
| `pnpm test:cov`  | Unit tests plus the coverage report      |
| `pnpm test:e2e`  | Integration tests, real Postgres         |
| `pnpm format`    | Rewrite files with Prettier              |

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
curl localhost:3000/readyz   # {"status":"ok","info":{"database":{"status":"up"},...}}
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

Runtime image is **337 MB** on `node:24-alpine`, containing no TypeScript
toolchain, no dev dependencies and no package manager. It grew from 316 MB when
the security work in [CI](#ci) landed: `apk upgrade` writes patched packages as
a new layer, and deleting npm adds whiteouts rather than reclaiming the base
layer's bytes. Twenty megabytes is a fair price for an image with no known
fixable HIGH or CRITICAL vulnerabilities.

Notes on the image:

- **Multi-stage.** Dependencies install from manifests alone in a `deps` stage,
  so that layer caches until a dependency actually changes.
- **`pnpm deploy --prod --legacy`** resolves workspace links into a real,
  self-contained `node_modules` and drops devDependencies. The runtime stage is
  then a plain copy of `node_modules`, `dist` and `package.json` — no pnpm, no
  TypeScript, no symlinks escaping the image.
- **Runs as the unprivileged `node` user** that `node:alpine` already provides.
- **No npm, and OS packages patched at build time.** The container only ever
  runs `node dist/main.js`, so the bundled package manager is deleted and
  `apk upgrade` applies fixes the published base has not picked up yet. Both
  are what turn the CI scan gate from red to green — see [CI](#ci).
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

Built on `@nestjs/terminus`, so the two answer in its shape — `status`, plus an
`info`/`error` split naming each indicator:

| Endpoint       | Meaning                                        | Touches Postgres          |
| -------------- | ---------------------------------------------- | ------------------------- |
| `GET /healthz` | Liveness — is the process up?                  | No                        |
| `GET /readyz`  | Readiness — can it serve traffic? `503` if not | Yes (`SELECT 1` + schema) |

A failing readiness check should pull an instance out of rotation; a failing
liveness check should restart it. Conflating them turns a brief database blip
into a restart loop — which is why `/healthz` answers `200` even with Postgres
gone, reporting `degraded` in its details rather than inviting a kill.

**Readiness checks the schema, not just the socket.** A database that answers
`SELECT 1` while two migrations behind will reject every query the new code
makes, so `/readyz` compares the migrations the build ships against the
`schema_migrations` ledger and answers `503` — naming the pending versions —
until they match. That makes a half-finished deploy visible as "not ready"
instead of as a wave of 500s:

```json
{
  "status": "error",
  "info": { "database": { "status": "up" } },
  "error": { "migrations": { "status": "down", "pending": ["0004_ledger_append_only"] } }
}
```

The probes run against a two-connection pool of their own rather than the
application pool. A check that queues behind saturated application traffic
answers late, and an orchestrator reads a timed-out readiness check as "down" —
turning load into an outage.

`api` waits for `db` via `condition: service_healthy` — the API validates config
and connects on boot, so racing Postgres would just produce a restart loop. The
compose healthcheck and the image's `HEALTHCHECK` both call `/readyz`, which is
why the image carries its `migrations/` directory beside `dist/`.

Terminus's peer range stops at NestJS 11 and this project is on 12, but unlike
`nestjs-pino` (see [Logging](#logging)) it loads and runs there: its CommonJS
build `require()`s Nest's ESM packages, which Node 24 permits outside a cycle.
Jest's ESM runtime is stricter, so `test/setup-env.ts` evaluates those packages
before any suite links Terminus.

## Logging

Structured JSON on stdout, one object per line, with a correlation ID on
**every** line:

```json
{
  "level": 30,
  "time": 1787999823547,
  "correlationId": "demo-correlation-123",
  "req": { "method": "POST", "path": "/events" },
  "res": { "status": 400 },
  "latencyMs": 5,
  "msg": "request completed"
}
```

- **Correlation ID** comes from `X-Correlation-Id` or `X-Request-Id` if the
  caller sends one, otherwise it is generated. It is echoed back on the
  response so a client can quote it in a bug report.
- It propagates through `AsyncLocalStorage`, so a log emitted in a repository
  four calls below the controller carries it without anyone passing it down.
  The same mechanism carries the database transaction.
- **Request bodies are never logged.** Only an allow-list of fields is
  serialised, so an endpoint that later accepts card details cannot leak them
  by default. `redact` is a second line of defence, not the first.
- The idempotency key **is** logged — it is the most useful field when tracing
  a retry.
- Verbosity follows `LOG_LEVEL` (see below); `/healthz` and `/readyz` are
  excluded so health checks do not drown the log.

`nestjs-pino` is the usual choice, but it ships CommonJS and `require()`s
`@nestjs/common`, which is ESM-only from NestJS 12 — it fails at import. pino
and pino-http are used directly instead.

## Testing

```bash
pnpm verify   # lint + typecheck + unit (with coverage) + integration
```

That is the whole command, locally and in CI —
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs it and nothing else.

**170 unit tests** run in under a second against no database at all. The inner
layers are framework-free by construction, so a test double is a plain class
implementing a port — no DI container, no mocking library.

**123 integration tests** run against a real Postgres that the suite starts
itself: [Testcontainers](https://testcontainers.com/) brings up the same
`postgres:17-alpine` image compose uses, and the project's **own migration
runner** applies the schema — the path a deploy takes, so a migration that
would fail in production fails here first. There is no "start the database
first" step, and no CI service container.

Two details that make parallel suites safe against one server:

- **A database per Jest worker**, cloned from a migrated template
  (`CREATE DATABASE … TEMPLATE`, which Postgres does by copying files). Against
  a shared database, a reset in one worker would truncate rows another was
  asserting on.
- **`resetDatabase()`**, the reusable helper suites call in `beforeAll` — or in
  `beforeEach` where isolation actually matters, as the expiry suite does,
  since the sweeper claims every lapsed reservation in the database.

**One journey test** sits on top of them — create event → hold seats → pay →
replay the payment → refund — driven over a real socket against a listening
server, watching the same overview endpoint a client would poll take the seats
from available to held to sold and back. It is one scenario on purpose: it
proves the pieces compose, and every error branch is asserted a layer down.

Mocks are deliberately absent from this layer: exactly one of twenty concurrent
holds winning a seat is a fact about Postgres row locks and an exclusion
constraint, and only Postgres can demonstrate it.

`pnpm test:cov` writes an lcov report to `apps/api/coverage/` and fails below
95% for `domain/` and `application/` — the layers unit tests own.
`infrastructure/` and `interface/` are covered by the integration suite instead,
where the queries and filters they exist to drive actually run.

Why the rest of it looks the way it does — the reset helper's two preserved
tables, the suites that spawn a real process, the Docker discovery for Colima —
is in [`docs/testing.md`](docs/testing.md).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — **lint → test → build →
scan → push**, in two jobs:

| Job      | What it does                                                                    |
| -------- | ------------------------------------------------------------------------------- |
| `verify` | `pnpm verify`: lint, typecheck, unit tests with coverage, integration tests     |
| `image`  | Builds the shipping image, scans it with Trivy, and pushes — from main or a tag |

`verify` is the merge gate, and it is the same command you run locally, so
there is no CI-only incantation to keep in sync. `image` waits for it: nothing
is built from code that does not lint or pass its tests.

**The scan is a gate, not a report.** Trivy fails the pipeline on `HIGH` or
`CRITICAL` vulnerabilities that have a fix available (`--ignore-unfixed`, since
an unfixed CVE is not actionable at build time). An accepted finding goes in
[`.trivyignore`](.trivyignore) with a reason and a date beside it — the file is
empty today. The full report, medium severity included, is uploaded as an
artifact whether the gate passes or fails.

Making that gate pass took two changes to the runtime image, both worth having
anyway:

- **npm is deleted.** The container runs `node dist/main.js` and never installs
  anything, so the package manager the base image bundles is attack surface —
  and its own dependencies (`tar`, `brace-expansion`, `ip-address`) were what
  the scanner reported against an image that never calls them.
- **`apk upgrade` runs at build time.** Alpine had a patched openssl before
  `node:24-alpine` was rebuilt with it. Waiting for someone else's rebuild is
  not a vulnerability policy.

**Publishing is narrow on purpose.** The push steps are skipped unless the event
is a push to `main` or a `v*` tag, so a pull request — including one from a fork
— can never publish an image. Credentials are the Actions-provided
`GITHUB_TOKEN`, so no long-lived registry secret is stored anywhere.

Images go to `ghcr.io/<owner>/event-ticketing-api`, tagged with the full commit
SHA (always), `latest` (default branch only) and the git tag (on `v*`). Every
running container is therefore traceable to the commit it came from.

**Caching**: the pnpm store is keyed on the lockfile via `setup-node`, and
Docker layers use the GitHub Actions cache. The image is built once with
`load: true` so Trivy scans the exact bytes that would be pushed; the push step
reuses that cache rather than compiling anything a second time.

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
