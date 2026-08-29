# Testing

The pyramid, and what each layer is allowed to know.

| Layer           | Where                               | Runs against          | Command         |
| --------------- | ----------------------------------- | --------------------- | --------------- |
| **Unit**        | `src/**/*.spec.ts`, beside the code | Nothing. Plain fakes. | `pnpm test`     |
| **Integration** | `apps/api/test/*.e2e-spec.ts`       | A real Postgres       | `pnpm test:e2e` |
| **Everything**  | —                                   | —                     | `pnpm verify`   |

`pnpm verify` is the single command: lint, typecheck, unit tests with coverage,
then the integration suite. CI runs exactly that and nothing else, so a green
laptop and a green pipeline mean the same thing.

## Unit tests: no database, no container, no mocks of our own code

The inner layers are framework-free by construction — `domain/` holds the rules,
`application/` orchestrates them through ports — so their tests need no DI
container and no test doubles library. A fake is a plain class implementing the
port:

```ts
class FakeReservations implements ReservationRepository {
  current: Reservation | null = pendingHold();
  findById() {
    return Promise.resolve(this.current);
  }
  // ...
}
```

That is the payoff of the layering, and it is why these run in under a second.

What they assert is decisions, never interactions with a mock: that a
mismatched payment amount is refused _before_ anything is written, that
cancelling a CONFIRMED hold throws, that a refund posts the mirror image of the
sale rather than editing it.

## Integration tests: a real Postgres, provisioned by the suite

Constraints, row locks, transaction visibility and triggers are Postgres
features. A mock cannot show that two concurrent holds on one seat produce
exactly one winner — only Postgres can, so these suites talk to it.

`test/support/global-setup.ts` starts one container with
[Testcontainers](https://testcontainers.com/), applies **the project's own
migration runner** (`scripts/migrate.ts`, the same one a deployment runs), and
publishes what it created through the environment. Teardown stops it.

Three decisions worth explaining:

- **A database per Jest worker.** Suites run in parallel processes. Against one
  shared database, `resetDatabase()` would truncate rows another worker was
  mid-assertion on. Global setup creates one database per worker, so a reset is
  a local operation and the parallelism survives.
- **Cloned from a migrated template**, not migrated N times. The runner executes
  once against `ticketing_template`; each worker database is
  `CREATE DATABASE … TEMPLATE`, which Postgres does by copying files.
- **The migration runner, not `drizzle-kit push`.** Tests exercise the same path
  a deploy takes, so a migration that would fail in production fails here first.

### The reset helper

```ts
import { resetDatabase } from './support/database.js';

beforeAll(async () => {
  await resetDatabase(); // a clean slate for this suite
});
```

`expiry.e2e-spec.ts` calls it in `beforeEach` instead, because the sweeper
claims every lapsed reservation in the database — a leftover row from the
previous test would land in this one's count.

It truncates every transactional table and deliberately preserves two:
`schema_migrations` (the ledger the readiness probe reads) and
`ledger_accounts` (the chart of accounts is reference data, arriving in
migration `0004`, and the ledger's foreign keys point at it).

`TRUNCATE` does not fire row triggers, so it bypasses the append-only guard on
`ledger_entries`. That exemption is confined to the harness — nothing in the
application can delete a ledger entry.

### Running against a database you already have

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm test:e2e
```

No container is started; template and worker databases are created on that
server instead. The rest of the flow is identical, so the two paths cannot
drift.

### Docker discovery

Testcontainers looks for `DOCKER_HOST`, then `/var/run/docker.sock`. Neither
exists under a VM-based runtime such as Colima or Rancher Desktop, where the
endpoint lives in the docker CLI's _context_ — so global setup asks the CLI and
sets `DOCKER_HOST` itself, plus `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` for the
Ryuk reaper, which mounts the socket from inside the VM. On a stock Linux
daemon and in CI this is a no-op.

## Two suites that run out of process

`config.e2e-spec.ts` and `health.e2e-spec.ts` spawn `dist/main.js` rather than
building an app with `Test.createTestingModule`, because what they assert is
only observable from outside:

- configuration validation happens when the module is _imported_, so a missing
  `DATABASE_URL` must be seen as a process that exits non-zero;
- readiness must report 503 when the database is genuinely gone, which is done
  by pointing a real process at a dead port — not by substituting a fake probe.

## Coverage

`pnpm test:cov` writes a report to `apps/api/coverage/` (terminal summary plus
lcov HTML) and fails below its floors: 95% overall for `domain/` and
`application/`, with the domain held to 95% branches.

It measures those two layers only. `infrastructure/` and `interface/` are
covered by the integration suite against a real database, where the queries and
filters they exist to drive actually run; counting them in a unit-coverage
number would either report them as untested or invite mock-heavy tests that
assert the mock.

One line stays uncovered on purpose: `LedgerTransaction`'s zero-amount guard.
`LedgerEntry` already refuses a zero amount, so no valid set of entries can sum
to zero — the guard is defence against a future change, and unreachable today.
