# Event Ticketing

A seat reservation and ticketing platform. This repository is a pnpm + Turborepo
monorepo holding a NestJS API and a Next.js web client.

> Status: **TICK-1** — scaffold only. There is no database, no configuration
> layer, and no domain model yet; those arrive in TICK-2 through TICK-6.

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
pnpm dev
```

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
