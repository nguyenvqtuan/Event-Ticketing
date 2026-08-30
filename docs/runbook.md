# Deployment runbook

How to deploy the API, roll it back, and tell whether it worked. Written to be
followed by someone who did not build it.

Two rules carry most of the weight:

1. **Migrations are their own step**, run to completion before any new instance
   serves traffic. The application never migrates itself.
2. **Instances stop by draining**, not by dying. `SIGTERM` means "finish what
   you are doing, then go".

## Before you start

| You need             | Where it comes from                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The image            | CI builds, scans and pushes `ghcr.io/<owner>/event-ticketing-api` on merges to `main` and on `v*` tags. Deploy a tag or a commit SHA, never `latest`. |
| `DATABASE_URL`       | The environment's Postgres. The deploying identity needs DDL rights, because the migration step runs `ALTER`/`CREATE`.                                |
| Registry pull access | The image is published to GHCR by `GITHUB_TOKEN`; runtime pulls need their own credential.                                                            |
| `curl` and `jq`      | Local, for the smoke test.                                                                                                                            |

Images are tagged `type=sha,format=long` on every build, plus `latest` on the
default branch and the version on a `v*` tag. **Deploy the SHA or the version
tag** — `latest` moves, which makes "what is actually running" unanswerable and
a rollback ambiguous.

## Configuration

Every variable the API reads is declared in `apps/api/src/config/env.schema.ts`
and validated **at import time**. A missing or malformed value means the process
exits non-zero on boot rather than serving traffic misconfigured — so a bad
config is a failed deploy, not an incident.

| Variable                  | Required | Default                 | Notes                                                                              |
| ------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`            | **Yes**  | —                       | No default on purpose: a wrong default would silently point at the wrong database. |
| `NODE_ENV`                | No       | `development`           | Set `production`.                                                                  |
| `PORT`                    | No       | `3000`                  |                                                                                    |
| `LOG_LEVEL`               | No       | `log`                   | `error` \| `warn` \| `log` \| `debug` \| `verbose`. JSON to stdout.                |
| `CORS_ORIGIN`             | No       | `http://localhost:3001` | **Set this per environment.** The default is a developer laptop.                   |
| `RESERVATION_TTL_SECONDS` | No       | `900`                   | How long a seat hold survives. Changing it affects live holds.                     |
| `SHUTDOWN_TIMEOUT_MS`     | No       | `10000`                 | Drain budget. Must stay below the platform's kill timeout.                         |

`apps/api/.env.example` is the same list in copyable form.

## Deploy

```
  1. Pick the image             → a SHA or version tag, not `latest`
  2. Run the migration step     → to completion, exit 0
  3. Roll out                   → readiness gates each instance
  4. Smoke test                 → before the change is called done
  5. Old instances drain        → and exit 0
```

Steps 2 and 3 never overlap. Everything below is why, and what to do when a
step fails.

### Step 1 — Pick the image

```bash
export IMAGE=ghcr.io/<owner>/event-ticketing-api:<sha-or-tag>
docker pull "$IMAGE"
```

CI has already built and scanned it: `verify` (lint, typecheck, unit,
integration) then `image` (build, Trivy gate on HIGH/CRITICAL, push). An image
that exists in the registry has passed both.

### Step 2 — Run the migration step

The image carries the migration runner alongside the SQL, so the schema is
applied by the same artifact that expects it.

```bash
# What would run:
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  node --experimental-strip-types scripts/migrate.ts status

# Apply:
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  node --experimental-strip-types scripts/migrate.ts up
```

**Wait for exit 0 before step 3.** On Kubernetes this is a `Job` gated before
the rollout — not a sidecar, which would run once per pod and reintroduce the
race this exists to avoid.

Locally, compose models the same ordering, and is the cheapest way to rehearse
it:

```bash
docker compose up --build     # db (healthy) → migrate (exits 0) → api
```

**If it fails:** do not roll out. Each migration runs in a transaction —
Postgres has transactional DDL — so a failure leaves nothing applied and the old
instances keep serving the old schema, which is a consistent state. Fix forward
and re-run; the step is safe to repeat, as applied versions are skipped.

#### Why the app does not do this itself

There is no migration call anywhere in `src/`. Boot validates configuration,
opens a pool, and listens.

If the app migrated on boot, rolling out N replicas would start N runners racing
for the same `schema_migrations` ledger, and "the schema is ready" would come to
mean "whichever replica won got there first". A replica that lost the race, or
started before the winner committed, would serve new code against an old schema.

What the app does instead is **compare**. `PostgresMigrationsProbe` reads the
migrations the image ships against the versions the database records, and
`/readyz` returns 503 while they disagree, naming what is pending. A half-done
deploy is therefore visible as "not ready" rather than as sporadic errors, and
an instance rolled out ahead of its migration takes itself out of rotation
instead of failing requests.

### Step 3 — Roll out

Replace instances one batch at a time, and **let readiness gate each one**. A new
instance must answer `/readyz` with 200 before it receives traffic:

```bash
curl -fsS "$BASE_URL/readyz" | jq
# {"status":"ok","info":{"database":{"status":"up"},"migrations":{"status":"up"}}, ...}
```

- `/healthz` — liveness. The process is up; touches nothing external. A failure
  means restart.
- `/readyz` — readiness. Postgres is reachable **and** the schema matches the
  migrations this build ships. A failure means take it out of rotation.

They are deliberately distinct. Wiring a restart to readiness turns a brief
database blip into a restart loop.

**If readiness stays 503 with a `pending` list**, step 2 did not run or did not
finish. That is a deploy-order problem, not a bad build — the instance is
telling you the truth.

### Step 4 — Smoke test

See [Post-deploy smoke test](#post-deploy-smoke-test) below. Do this before
calling the deploy done.

### Step 5 — Old instances drain

Handled for you, but this is what should happen. On `SIGTERM`
(`installShutdownHandlers` in `src/main.ts`):

1. The adapter is marked shutting down, so in-flight responses carry
   `Connection: close` and clients stop reusing those sockets.
2. `server.close()` — **new connections are refused**, the ones already being
   served are left alone.
3. Nest runs `onApplicationShutdown`, where the connection pool ends. This
   happens _after_ the drain, which is what lets an in-flight request finish its
   query instead of dying on a closed connection.
4. Logs are flushed and the process exits **0**.

`SHUTDOWN_TIMEOUT_MS` (10s) bounds step 2. If in-flight requests have not
finished by then the process exits **1** — work was abandoned, and that should
not read the same as a clean stop.

**A container exiting 143 means it was killed, not drained.** Check that the
platform's grace period exceeds the drain budget.

| Setting                             | Value | Why                         |
| ----------------------------------- | ----- | --------------------------- |
| `SHUTDOWN_TIMEOUT_MS`               | 10s   | the app's own drain budget  |
| compose `stop_grace_period`         | 30s   | set in `docker-compose.yml` |
| k8s `terminationGracePeriodSeconds` | 30s   | must exceed preStop + drain |

#### The gap this does not close

A pod's endpoint is not removed from its load balancer the instant `SIGTERM`
arrives. For a short window the LB may still route to an instance that has
already stopped accepting connections — those requests fail to connect rather
than being drained, because by then there is nothing to drain into.

That is a routing problem, not an application one. The fix is a pre-stop delay,
so the endpoint is withdrawn _before_ the app stops listening:

```yaml
lifecycle:
  preStop:
    exec: { command: ['sleep', '5'] }
```

`terminationGracePeriodSeconds` must then cover the sleep **plus** the drain.

## Post-deploy smoke test

```bash
./apps/api/scripts/smoke-test.sh "$BASE_URL"           # read-only
./apps/api/scripts/smoke-test.sh "$BASE_URL" --full    # + a real purchase
```

Exits 0 when everything passes and 1 on the first failure, so it can gate a
pipeline step rather than be something a human squints at.

**Read-only (safe against production).** Run this on every deploy.

- [ ] `/healthz` returns 200 — the process is up
- [ ] `/readyz` returns 200 with `database` and `migrations` both `up` — a 503
      here names the pending migrations and tells you step 2 is incomplete
- [ ] A caller-supplied `x-correlation-id` is echoed back unchanged — traces
      from a bug report will resolve to log lines
- [ ] CORS reports the allowed origin — confirm it is _this_ environment's, not
      the `localhost:3001` default
- [ ] An unknown event id returns 404, a malformed one returns 400 — the
      exception filters are wired up in this build

**`--full` (writes data).** Run on staging routinely; in production it is a
deliberate decision, because it creates a real event and real ledger entries,
and ledger entries are append-only by design.

- [ ] Create an event → 201, seat inventory generated
- [ ] Hold two seats → 201
- [ ] Pay with an `Idempotency-Key` → 200, an order is returned
- [ ] **Replay the same key → 200 with the same `orderId`** — not a second
      charge. The most important behaviour on this path
- [ ] Refund → 200
- [ ] Availability returns to its original count — the seats really were taken
      out of inventory and really were returned

The `--full` run leaves its event behind; it prints the id.

**If the smoke test fails, roll back.** It is cheaper than diagnosing under load.

## Rollback

**Roll back the code first.** It is fast, safe, and almost always sufficient —
because expand and migrate steps are backwards-compatible by construction, the
previous image runs against the current schema.

```bash
export IMAGE=ghcr.io/<owner>/event-ticketing-api:<previous-sha>
# Redeploy it. No migration step: the schema already satisfies the old code.
```

Schema rollback is a separate, rarer decision:

| Situation                            | Action                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| New code is broken, schema is fine   | **Roll back the image.** Nothing else. The common case.                                      |
| The migration itself failed part-way | Nothing to undo — each migration is transactional, so it applied or it did not. Fix forward. |
| An **expand** migration must go      | `migrate.ts down` is safe: nothing depended on the new shape yet.                            |
| A **contract** migration must go     | It cannot be undone by rolling back. The old column is gone; restore from backup.            |

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" "$IMAGE" \
  node --experimental-strip-types scripts/migrate.ts down       # last migration
```

### Why contract is a separate deploy from expand

This is the whole reason a rollback is usually just a redeploy.

A rename done in one step — `ALTER TABLE seats RENAME code TO label` — breaks
every instance still running the old code the moment it commits, and during a
rolling deploy old and new code run against the same database at the same time.
It also cannot be rolled back cleanly, because the old code's column no longer
exists.

Splitting it means **one deploy never both adds and removes**:

| Deploy         | Migration           | Application                                 | Rollback                                      |
| -------------- | ------------------- | ------------------------------------------- | --------------------------------------------- |
| 1 **expand**   | `ADD COLUMN label`  | writes `code` **and** `label`, reads `code` | redeploy; column is unused and harmless       |
| 2 **migrate**  | backfill in batches | reads `label`                               | redeploy; `code` is still written and current |
| 3 **contract** | `DROP COLUMN code`  | writes and reads `label` only               | **not reversible**                            |

Deploys 1 and 2 are both reversible by redeploying the image, because the old
shape is still there and still maintained. Only deploy 3 destroys it — which is
why it lags **days, not minutes**, behind the deploy that stopped using the old
column. By the time contract runs, the code that needed it has been in
production long enough to trust.

Full method and worked examples:
[`docs/db.md`](db.md#no-downtime-migrations-expand--migrate--contract).

## Writing a migration that will not lock the table

`ALTER TABLE` and `CREATE INDEX` take locks. Against an idle table that costs
nothing; against a live one, an `ACCESS EXCLUSIVE` lock held for an index build
stops every reader and writer for as long as it takes.

| Instead of                 | Write                                                       |
| -------------------------- | ----------------------------------------------------------- |
| `CREATE INDEX`             | `CREATE INDEX CONCURRENTLY` (cannot run in a transaction)   |
| `DROP INDEX`               | `DROP INDEX CONCURRENTLY`                                   |
| `ADD COLUMN ... NOT NULL`  | add nullable or with a constant default, backfill, then set |
| `ADD CONSTRAINT ... CHECK` | `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT`  |
| one big `UPDATE`           | batched updates, committed between batches                  |
| `ALTER COLUMN TYPE`        | new column, dual-write, backfill, swap, drop                |

Adding a column **with a constant default is metadata-only** on PG 11+ and does
not rewrite the table — that one is safe.

### Audit of the migrations in this repository

Stated plainly, because the rule above is worth nothing if nobody checks it:

| Migration                  | Blocking? | Why it was acceptable                                                                                                                                                                                        |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0000_init_schema`         | No        | Creates the schema. Empty database, no concurrent traffic.                                                                                                                                                   |
| `0001_seat_exclusivity...` | **Yes**   | `ADD CONSTRAINT ... EXCLUDE USING gist` and a validating `CHECK` both take `ACCESS EXCLUSIVE` on `reservation_items` and hold it while the GiST index builds. Applied pre-production against an empty table. |
| `0002_drop_unused_indexes` | **Yes**   | Plain `DROP INDEX`; brief, but `ACCESS EXCLUSIVE`. Should be `DROP INDEX CONCURRENTLY`.                                                                                                                      |
| `0003_optimistic_locking`  | No        | `ADD COLUMN version integer DEFAULT 0 NOT NULL` — metadata-only on PG 11+.                                                                                                                                   |
| `0004_ledger_append_only`  | **Yes**   | `DROP INDEX` + `CREATE UNIQUE INDEX` on `ledger_accounts`, a reference table of a few rows, so the lock is held for microseconds.                                                                            |

These are **not** rewritten. An applied migration is history: editing one makes
the file disagree with what actually ran on every database that has already run
it, and `schema_migrations` would not notice. All were applied before there was
production traffic to disrupt. The table above is the standard the _next_
migration is held to.

## Troubleshooting

| Symptom                                                  | Cause                                                        | Do this                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Process exits non-zero immediately, logs name a variable | Config validation failed at import                           | Fix the variable; see the Configuration table                  |
| `/readyz` 503, `migrations` down with `pending`          | The migration step has not run or did not finish             | Run step 2, then re-check                                      |
| `/readyz` 503, `database` down                           | Postgres unreachable — wrong URL, network, credentials       | Check `DATABASE_URL` and connectivity                          |
| `/healthz` 200 but `/readyz` 503                         | Working as designed — the process is up, a dependency is not | Do not restart; the instance is out of rotation on purpose     |
| Container exit code 143                                  | `SIGKILL`ed mid-drain                                        | Raise the platform grace period above `SHUTDOWN_TIMEOUT_MS`    |
| Container exit code 1 on shutdown                        | Drain deadline expired; requests were abandoned              | Look for slow requests; consider raising `SHUTDOWN_TIMEOUT_MS` |
| Requests fail during a rollout                           | LB still routing to a draining instance                      | Add the `preStop` delay above                                  |
| A retried payment charged twice                          | Would be a bug — the smoke test's replay check covers it     | Roll back, capture the `Idempotency-Key` and correlation id    |

Every log line is JSON on stdout and carries a `correlationId`; responses echo
it as `x-correlation-id`. That id is the fastest way from a user report to the
request that caused it.
