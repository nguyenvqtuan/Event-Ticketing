# Indexing & query plans

Which indexes exist, which query justifies each, and the `EXPLAIN ANALYZE`
evidence. Companion to [`db.md`](db.md).

**Headline result:** the schema needed **two indexes removed**, not added. The
partial index this ticket asked for was built, measured, and rejected — the
numbers are below.

## Reproducing

```bash
docker compose up -d db
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/event_ticketing
pnpm --filter @repo/api db:migrate
pnpm --filter @repo/api db:seed:perf     # 120k seats, 72k claims, 100k entries
pnpm --filter @repo/api db:explain
```

Measured on Postgres 17 (alpine) under colima, 4 vCPU / 6 GB.

### Two things that invalidate this kind of measurement

**Data shape matters as much as size.** The first version of the seed used
3 events × 40k seats. That makes `event_id` 33% selective, and at that
selectivity Postgres correctly prefers a sequential scan — every index on
`seats` looked worthless. A venue runs many events of moderate size, so the
seed is now 60 events × 2000 seats (`event_id` ≈ 1.7% selective) and the index
is chosen. Getting this wrong makes a good index look useless.

**Prefer buffers to milliseconds.** At sub-millisecond scale, wall-clock
varies more between runs of the _same_ plan than between different plans.
`Buffers: shared hit` is deterministic. Every claim below is made on buffers;
timings are given for context only.

## The hot queries

|         | Query                                                        | Frequency   |
| ------- | ------------------------------------------------------------ | ----------- |
| **Q1**  | Available seats for an event, `LIMIT 100` (seat map page)    | High        |
| **Q1b** | `COUNT` of available seats for an event (availability badge) | Medium      |
| **Q2**  | Reservations for one holder                                  | Medium      |
| **Q3**  | Ledger entries for one account                               | Medium      |
| **Q4**  | Sweep expired holds                                          | Background  |
| **Q5**  | Is _one_ seat available? (every hold attempt)                | **Highest** |

Availability is derived, not stored (see [`domain.md`](domain.md)), so Q1/Q1b/Q5
are anti-joins against claims whose validity period contains `now()` rather than
reads of a status column.

## Results

| Query | Plan                                                           | Buffers | Time     |
| ----- | -------------------------------------------------------------- | ------- | -------- |
| Q1    | Nested Loop Anti Join; index scan both sides                   | 789     | ~0.6 ms  |
| Q1b   | Hash Right Anti Join; bitmap scan on seats, seq scan on claims | 2484    | ~9.3 ms  |
| Q2    | Bitmap scan on `reservations_holder_idx`                       | 16      | ~0.07 ms |
| Q3    | **Index Scan Backward** on `ledger_entries_account_idx`        | 8       | ~0.06 ms |
| Q4    | Bitmap scan on `reservations_pending_expiry_idx` (partial)     | 48      | ~0.42 ms |
| Q5    | **Index Only Scan** on the GiST exclusion index                | 31      | ~0.28 ms |

Two of these are worth calling out.

**Q3 needs no sort.** `ledger_entries_account_idx` is `(account_id, created_at)`
in that order, so filtering by account leaves rows already ordered by time and
`ORDER BY created_at DESC LIMIT 50` becomes a backward index scan. Reverse the
columns and it would still filter, but every query would sort the account's
whole history to return 50 rows. **Equality columns first, then the ordering
column** — that is the rationale for every composite index here.

**Q5 is served by a constraint.** The GiST index backing
`reservation_items_no_overlapping_claim` is `(seat_id, valid_during)`, which is
exactly the shape of "is this seat claimed right now?". The index that prevents
double-booking also answers the highest-frequency read, index-only. It was built
for correctness and came with a performance win.

## The partial index that did not survive measurement

The AC asks for "at least one partial index for AVAILABLE seats by `event_id`".
I built the closest thing this model permits and measured it:

```sql
CREATE INDEX reservation_items_live_claims_idx
  ON reservation_items (seat_id) INCLUDE (valid_during)
  WHERE claim_state <> 'RELEASED';
```

Partial (40% of claims in the seed are cancelled checkouts, so it is genuinely
smaller: 2504 kB vs 2768 kB) and covering (the probe becomes index-only).

Q1, three runs each, `reservation_items_seat_idx` being the full equivalent:

| Configuration | Index chosen            | Buffers | Time         |
| ------------- | ----------------------- | ------- | ------------ |
| Both present  | full                    | 789     | 0.56–0.76 ms |
| Partial only  | partial, **index-only** | **723** | 0.55–0.68 ms |
| Full only     | full                    | 789     | 0.49–0.89 ms |

Read that carefully:

- **With both present the planner never picks the partial one.** As a second
  index it is pure write cost — every insert maintains it, no read uses it.
- **As a replacement it wins on buffers** (723 vs 789, ~8%) but the timings
  overlap completely, so the win is real yet small.
- **It cannot replace the full index anyway.** `reservation_items.seat_id`
  references `seats` with `ON DELETE RESTRICT`, and that check must find _any_
  claim including `RELEASED` ones — precisely the rows the partial index
  excludes. Without a complete index, deleting an event would seq-scan 72k rows
  per seat.

It was also not chosen for Q1b (at 60% selectivity a seq scan is genuinely
cheaper) nor for Q5 (the GiST index wins). Rejected, and the migration deleted.

### Why "a partial index for AVAILABLE seats by event_id" cannot exist here

Same root cause as the exclusion constraint in [`db.md`](db.md):

1. **`seats` has no status column** to write a predicate against — availability
   is derived from claims, deliberately.
2. **Liveness needs `now()`**, and an index predicate must be `IMMUTABLE`.
   `now()` is `STABLE`, so `WHERE valid_during @> now()` is rejected outright.

A partial index on `claim_state` alone is the only expressible approximation,
and it measures as above.

The schema does contain a partial index that is measured and used:
`reservations_pending_expiry_idx ... WHERE state = 'PENDING'`, serving Q4 in 48
buffers. Restricting it to `PENDING` keeps it at 208 kB — the smallest index in
the schema — because confirmed and cancelled reservations can never be swept.

## Index inventory

Every index, and what justifies it. Anything unjustified was dropped.

| Index                                                        | Size    | Justified by                                                            |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------- |
| `seats_event_code_uq (event_id, code)`                       | 8272 kB | Q1/Q1b seats side + uniqueness of seat code within an event             |
| `reservation_items_seat_idx (seat_id)`                       | 2240 kB | Q1 probes (171 scans) + FK enforcement, which needs `RELEASED` rows too |
| `reservation_items_no_overlapping_claim` (GiST)              | 4264 kB | The double-booking constraint; also serves Q5 index-only                |
| `reservations_holder_idx (holder_id, created_at)`            | 600 kB  | Q2                                                                      |
| `reservations_pending_expiry_idx (expires_at) WHERE PENDING` | 208 kB  | Q4                                                                      |
| `ledger_entries_account_idx (account_id, created_at)`        | 656 kB  | Q3, backward scan with no sort                                          |
| `ledger_entries_transaction_idx (transaction_id)`            | 3128 kB | The balance trigger — see below                                         |
| `*_pkey`, `*_uq`                                             | —       | Primary keys and uniqueness constraints                                 |

**`ledger_entries_transaction_idx` is justified by a write path, not a query.**
It shows zero scans under the read workload, which makes it look like an
obvious deletion candidate. It is not: the deferred balance trigger sums every
entry of a transaction at `COMMIT`, and that lookup is by `transaction_id`.
Inserting a two-sided entry registers 2 scans. Drop it and every ledger write
seq-scans 100k rows.

The general lesson: `idx_scan = 0` means "no _query_ used it", not "unused".
Check constraint enforcement and triggers before deleting anything.

### Dropped

Migration `0002_drop_unused_indexes`:

| Index                                                | Why removed                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `events_on_sale_idx (sales_open_at, sales_close_at)` | Zero scans. No query filters on the sales window, and with a realistic number of events the planner seq-scans the table anyway.  |
| `ledger_transactions_reference_idx (reference)`      | Zero scans. "Find the transaction for order X" is plausible but not implemented; the index returns with the query that needs it. |

Both were added speculatively in TICK-5. Speculative indexes are not free: they
slow every write and take space, in exchange for nothing until a query arrives.

### Kept but unexercised

`idempotency_keys_expiry_idx` and `processed_events_kind_idx` sit on tables that
are still empty, because those features are not built. They cost nothing at zero
rows. They are declared here so the next person does not have to rediscover
that they are unproven — revisit them when the feature lands, and drop them if
no query materialises.

## Notes for later

- **Q1b is the weakest plan** (2484 buffers, ~9 ms) because it seq-scans all
  claims for the event. That is correct at 60% selectivity and fine at this
  size, but if availability counts become hot, cache the count rather than
  adding an index the planner will decline to use.
- **Re-run this after any schema change.** `db:explain` prints the plans and
  the index-usage table; an index that stops being chosen should be removed.
- **`VACUUM` matters for index-only scans.** They need the visibility map, so a
  freshly bulk-loaded table will not use them until vacuumed. The seed script
  runs `ANALYZE`; run `VACUUM ANALYZE` if index-only scans look absent.
