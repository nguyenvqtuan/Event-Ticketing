# Deployment runbook

How a release reaches production without dropping a request, and what to do
when it goes wrong.

Two rules carry most of the weight:

1. **Migrations are their own step**, run to completion before any new instance
   serves traffic. The application never migrates itself.
2. **Instances stop by draining**, not by dying. `SIGTERM` means "finish what
   you are doing, then go".

## Deploy order

```
  1. CI builds and scans the image           (.github/workflows/ci.yml)
  2. Run the migration step                  → to completion, exit 0
  3. Roll out the new instances              → readiness gates each one
  4. Old instances drain and exit 0
```

Steps 2 and 3 never overlap. Everything below is why.

## 1. Migrations

### The application does not run them

There is no migration call anywhere in `src/`. Boot validates configuration,
opens a pool and listens — nothing more.

That is deliberate. If the app migrated on boot, a rollout of N replicas would
start N runners racing for the same `schema_migrations` ledger, and "the schema
is ready" would come to mean "whichever replica won got there first". A replica
that lost the race, or started before the winner committed, would serve new
code against an old schema.

What the app does instead is **compare**. `PostgresMigrationsProbe` reads the
migrations the image ships and the versions `schema_migrations` records, and
`/readyz` returns 503 while they disagree — naming the pending versions. So a
half-done deploy is visible as "not ready" rather than as sporadic errors, and
an instance rolled out ahead of its migration takes itself out of rotation
instead of failing requests.

### Running the step

The shipping image carries the runner, so the migration is applied by the same
artifact that expects it — a separate migration image could drift from the SQL
this one ships.

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  node --experimental-strip-types scripts/migrate.ts up
```

Locally, compose models the same ordering: a `migrate` service runs once, and
`api` waits on `service_completed_successfully`.

```bash
docker compose up --build     # db → migrate → api
```

On Kubernetes this is a `Job` (or an `initContainer` when one replica is
acceptable), gated before the rollout — not a sidecar, which would run per pod
and reintroduce the race.

Other commands, all against the same ledger:

```bash
node --experimental-strip-types scripts/migrate.ts status   # what is applied vs shipped
node --experimental-strip-types scripts/migrate.ts down      # roll back the last one
node --experimental-strip-types scripts/migrate.ts down all  # roll back everything
```

Each migration runs inside a transaction — Postgres has transactional DDL — so
a failure part-way leaves nothing behind and the step can simply be re-run.

### If the migration step fails

Do not roll out. The old instances are still serving against the old schema,
which is a consistent state; a failed migration leaves nothing applied, so the
system is exactly where it was. Fix forward and re-run.

## 2. Not locking the table while you do it

`ALTER TABLE` and `CREATE INDEX` take locks. On a table nobody is reading, that
costs nothing; on a live one, an `ACCESS EXCLUSIVE` lock held for the duration
of an index build stops every reader and writer for as long as it takes.

The full expand → migrate → contract method, with worked examples, is in
[`docs/db.md`](db.md#no-downtime-migrations-expand--migrate--contract). The
short version of what must never appear in a migration against a populated
table:

| Instead of                     | Write                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `CREATE INDEX`                 | `CREATE INDEX CONCURRENTLY` (cannot run in a transaction)   |
| `DROP INDEX`                   | `DROP INDEX CONCURRENTLY`                                   |
| `ADD COLUMN ... NOT NULL`      | add nullable or with a constant default, backfill, then set |
| `ADD CONSTRAINT ... CHECK`     | `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT`  |
| one big `UPDATE`               | batched updates, committed between batches                  |
| `ALTER COLUMN TYPE`            | new column, dual-write, backfill, swap, drop                |

Adding a column **with a constant default is metadata-only** on PG 11+ and does
not rewrite the table — that one is safe.

### Audit of the migrations in this repository

Stated plainly, because the rule above is worth nothing if nobody checks it:

| Migration                        | Blocking?  | Why it was acceptable                                                                |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `0000_init_schema`               | No         | Creates the schema. Empty database, no concurrent traffic.                            |
| `0001_seat_exclusivity...`       | **Yes**    | `ADD CONSTRAINT ... EXCLUDE USING gist` and a validating `CHECK` both take `ACCESS EXCLUSIVE` on `reservation_items` and hold it while the GiST index builds. Applied pre-production against an empty table. |
| `0002_drop_unused_indexes`       | **Yes**    | Plain `DROP INDEX`; brief, but `ACCESS EXCLUSIVE`. Should be `DROP INDEX CONCURRENTLY`. |
| `0003_optimistic_locking`        | No         | `ADD COLUMN version integer DEFAULT 0 NOT NULL` — metadata-only on PG 11+.            |
| `0004_ledger_append_only`        | **Yes**    | `DROP INDEX` + `CREATE UNIQUE INDEX` on `ledger_accounts`, a reference table of a few rows, so the lock is held for microseconds. |

These are **not** rewritten. An applied migration is history: editing one makes
the file disagree with what actually ran on every database that has already run
it, and `schema_migrations` would not notice. They were all applied before there
was production traffic to disrupt. The table above is the standard the *next*
migration is held to.

## 3. Graceful shutdown

`SIGTERM` starts a drain (`installShutdownHandlers` in `src/main.ts`). In order:

1. The adapter is marked as shutting down, so responses still in flight carry
   `Connection: close` and clients stop reusing those sockets.
2. `server.close()` — **new connections are refused**; the ones already being
   served are left alone.
3. Nest runs `onApplicationShutdown`, where `DatabaseContext` ends the pool.
   This happens *after* the drain, which is what lets an in-flight request
   finish its query instead of dying on a closed connection.
4. Logs are flushed and the process exits **0**.

`SHUTDOWN_TIMEOUT_MS` (default 10s) bounds step 2. If in-flight requests have
not finished by then the process exits **1** — work was abandoned, and that
should not read the same as a clean stop.

Nest's own `enableShutdownHooks()` is deliberately not used for signal handling:
it re-raises the signal after teardown, so the process dies *by* `SIGTERM`
(exit 143), and it applies no timeout, so one stuck request would hang the
container until the platform `SIGKILL`s it.

### Platform settings

The drain budget must fit inside the platform's kill timeout, or the drain is
cut short by a `SIGKILL` and none of the above matters.

| Setting                                | Value | Why                                     |
| -------------------------------------- | ----- | --------------------------------------- |
| `SHUTDOWN_TIMEOUT_MS`                  | 10s   | the app's own drain budget              |
| compose `stop_grace_period`            | 30s   | set in `docker-compose.yml`             |
| k8s `terminationGracePeriodSeconds`    | 30s   | must exceed preStop + drain             |

### The gap this does not close

A pod's readiness and its load balancer are not updated the instant `SIGTERM`
arrives. For a short window the LB may still send requests to an instance that
has already stopped accepting connections — they fail to connect rather than
being drained, because at that point there is nothing left to drain into.

That is a routing problem, not an application one, and the standard fix is a
pre-stop delay so the endpoint is removed *before* the app stops listening:

```yaml
lifecycle:
  preStop:
    exec: { command: ['sleep', '5'] }
```

`terminationGracePeriodSeconds` must then cover the sleep plus the drain.

## Rollback

Roll back the **image** first — it is instant and safe, because expand and
migrate steps are backwards-compatible by construction (that is the entire
point of splitting them).

Roll back a **migration** only if it was an expand or migrate step, with
`migrate.ts down`. Contract steps are irreversible by design: they drop the old
shape, which is why they lag days behind the deploy that stopped using it.

## Verifying a deploy

```bash
curl -fsS localhost:3000/healthz   # process is up
curl -fsS localhost:3000/readyz    # database reachable AND schema current
```

`/readyz` returning 503 with a `pending` list means the migration step has not
run, or did not finish. That is step 2 of the deploy order, not a bug in the
instance reporting it.
