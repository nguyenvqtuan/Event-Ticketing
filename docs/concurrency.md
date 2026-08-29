# Concurrency: holding seats without overbooking

How `POST /reservations` guarantees that when N requests race for the same
seat, exactly one wins — across multiple Node instances, because the guarantee
lives in Postgres rather than in application memory.

Companion to [`domain.md`](domain.md) and [`db.md`](db.md).

## Three layers, on purpose

| Layer | Mechanism                                   | Provides                                                             |
| ----- | ------------------------------------------- | -------------------------------------------------------------------- |
| 1     | `SELECT ... FOR UPDATE` on seat rows        | Clean conflicts — losers wait, then report _which_ seats went        |
| 2     | Exclusion constraint on `reservation_items` | The actual guarantee, for any writer that skips layer 1              |
| 3     | `Reservation` aggregate                     | Rejects empty/duplicate seats and non-positive TTLs before any write |

**Layer 1 gives good errors; layer 2 gives the guarantee.** That distinction is
the whole design. If the lock were the only protection, a future code path that
forgot to take it would silently double-book. If the constraint were the only
protection, every loser would surface a raw `23P01` and conflicts would be
control flow rather than an exceptional case.

## The hold path

```
BEGIN ISOLATION LEVEL READ COMMITTED
  SELECT id FROM seats
   WHERE event_id = $1 AND id = ANY($2)
   ORDER BY id
     FOR UPDATE                     -- ① lock, in a deterministic order

  SELECT seat_id FROM reservation_items      -- ② now safe to read
   WHERE seat_id = ANY(...)
     AND claim_state <> 'RELEASED'
     AND valid_during @> now()

  -- any row returned → 409, nothing written

  INSERT INTO reservations ...              -- ③ commit the hold
  INSERT INTO reservation_items ...         --    exclusion constraint applies
COMMIT                                       --    releases the locks
```

Step ② is only sound because of step ①. Without the lock this is a classic
time-of-check-to-time-of-use race: two requests both read "free", both write,
and only the constraint stops the second — as an error, after the fact.

## Why READ COMMITTED

Stated explicitly in `DrizzleTransactionRunner` rather than inherited as
Postgres's default, so the choice is visible in code.

**It suffices because of the row lock.** Under READ COMMITTED each statement
sees a fresh snapshot, and — the part that matters — a statement blocked on
`FOR UPDATE` **re-reads the newest committed version of the row** once the lock
is granted. So the loser of a race does not act on the stale snapshot it began
with; it sees the winner's committed claim and returns a clean 409.

### The REPEATABLE READ trade-off

REPEATABLE READ pins one snapshot for the whole transaction. A transaction that
tries to lock a row another transaction has since updated cannot silently
re-read it — that would violate the snapshot — so Postgres aborts it:

```
ERROR: could not serialize access due to concurrent update   (40001)
```

That is strictly worse here:

- **No extra safety.** The row lock already serialises writers, which is the
  only interleaving that could overbook.
- **Real cost.** Every loser becomes a retryable error rather than a definite
  answer, so the application needs a retry loop, and under heavy contention for
  a popular seat it retries repeatedly.
- **Worse errors.** `40001` says "try again", where READ COMMITTED can say
  "seat A12 is taken" — which is what the caller actually needs.

SERIALIZABLE would add predicate locking to protect against phantoms. There is
no phantom to protect against: the contended rows already exist, since seats
are created up front.

**When this would change:** if a hold ever had to enforce a rule over rows that
do not exist yet — "no more than 4 tickets per customer per event", say — a
`FOR UPDATE` on nothing locks nothing, and SERIALIZABLE (or a lock on a parent
row) becomes necessary.

## Deadlock avoidance

Seats are locked `ORDER BY id`, always.

Two overlapping multi-seat holds arriving in opposite orders is the textbook
deadlock:

```
T1: lock A ─────────► wants B  (held by T2)
T2: lock B ─────────► wants A  (held by T1)     → deadlock, one is killed
```

A global order makes the cycle impossible: both transactions want A first, so
one simply waits. Postgres would otherwise detect the deadlock after
`deadlock_timeout` (1s by default) and abort a victim with `40P01` — correct,
but a second of latency and an error the caller did nothing to deserve.

This is tested directly: three holds over overlapping seat sets, submitted in
different orders, produce one success and no deadlock.

## All-or-nothing

One unavailable seat fails the whole request. A partial hold would give the
caller seats they did not ask for and quietly consume inventory they may not
want — worse than a clear failure.

The 409 names the seats, so a client can decide:

```json
{
  "statusCode": 409,
  "error": "SeatsUnavailable",
  "message": "Cannot hold seats — already held or sold: 7c1f…",
  "unavailableSeatIds": ["7c1f…"],
  "missingSeatIds": []
}
```

`unavailable` (real, taken) is kept separate from `missing` (not part of this
event) because they mean different things: one is a race the client lost, the
other is a client bug.

## Expiry needs no lock

A hold's claim row carries `valid_during = [created_at, expires_at)`. When the
TTL passes the range no longer contains `now()`, so the seat is available again
— with no sweeper, no write, and nothing to serialise. Availability queries and
the exclusion constraint both evaluate the same predicate, so they cannot
disagree.

This is why `GET /reservations/:id` reports `expired: true` while the stored
`state` is still `PENDING`: expiry is a fact about the clock, not a flag
somebody has to set.

## Scope limits

- **Lock contention is per seat row.** Disjoint seats proceed fully in
  parallel; tested.
- **A hold locks at most 20 seats** (schema-enforced), bounding how long one
  request can hold locks others are waiting on.
- **No lock is held across a network call.** The transaction opens and commits
  inside one request; payment (TICK-9+) happens after the hold commits, never
  inside its transaction.
