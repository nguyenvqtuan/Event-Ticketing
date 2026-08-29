-- Performance seed data. Reproduces the EXPLAIN ANALYZE numbers in
-- docs/indexing.md.
--
--   pnpm --filter @repo/api db:reset
--   pnpm --filter @repo/api db:seed:perf
--
-- Produces 120k seats across 60 events, 72k seat claims and 100k ledger
-- entries — enough for the planner to prefer indexes over sequential scans.
-- On a few thousand rows Postgres seq-scans everything and every index looks
-- useless, which is how people conclude their indexes "did nothing".

\timing on

TRUNCATE ledger_entries, ledger_transactions, ledger_accounts,
         order_lines, orders, reservation_items, reservations, seats, events
  RESTART IDENTITY CASCADE;

-- 60 events × 2000 seats → 120k total --------------------------------------
--
-- The shape matters as much as the size. An earlier version of this script
-- used 3 events × 40k seats, which made event_id 33% selective — at that
-- selectivity Postgres correctly prefers a sequential scan and every index on
-- seats looks worthless. A venue runs many events of moderate size, so
-- event_id is genuinely selective (~1.7% here), and the index earns its place.
INSERT INTO events (id, name, starts_at, sales_open_at, sales_close_at)
SELECT md5('event-' || g)::uuid,
       'Perf Event ' || lpad(g::text, 3, '0'),
       now() + interval '60 days',
       now() - interval '1 day',
       now() + interval '59 days'
FROM generate_series(1, 60) g;

INSERT INTO seats (id, event_id, code, price_minor, currency)
SELECT md5(e.id::text || '-seat-' || g)::uuid,
       e.id,
       'S' || lpad(g::text, 6, '0'),
       3000 + (g % 40) * 250,
       'GBP'
FROM events e
CROSS JOIN generate_series(1, 2000) g;

-- Claims on the first 1200 seats of each event (72k total), in five buckets:
--   rn % 5 = 0 → SOLD        [now, infinity)      permanently unavailable
--   rn % 5 = 1 → HELD live   [now, now+15m)       currently unavailable
--   rn % 5 = 2 → HELD lapsed [now-2h, now-1h)     AVAILABLE again, unswept
--   rn % 5 = 3 → RELEASED                         cancelled
--   rn % 5 = 4 → RELEASED                         cancelled
--
-- Bucket 2 is the interesting one: those seats are sellable even though
-- nothing has updated their rows.
--
-- Buckets 3-4 make 40% of claims RELEASED — abandoned checkouts are common,
-- and without them a partial index that excludes RELEASED is the same size as
-- a full one, so it could never demonstrate a benefit.
CREATE TEMP TABLE picked AS
SELECT s.id AS seat_id,
       s.event_id,
       row_number() OVER (PARTITION BY s.event_id ORDER BY s.code) AS rn
FROM seats s;

DELETE FROM picked WHERE rn > 1200;

-- created_at is set explicitly, not left to its default: a lapsed hold needs
-- expires_at in the past, and `reservations_ttl_positive` (expires_at >
-- created_at) rightly rejects that if created_at is now().
INSERT INTO reservations (id, event_id, holder_id, state, created_at, expires_at)
SELECT md5(p.seat_id::text)::uuid,
       p.event_id,
       -- 5000 distinct holders, so "reservations for a user" returns a
       -- realistic handful rather than one row or everything.
       md5('holder-' || (p.rn % 5000))::uuid,
       -- The lapsed bucket stays PENDING, not EXPIRED: that is what an
       -- unswept hold actually looks like, and it is what the sweeper query
       -- (Q4) has to find.
       CASE p.rn % 5
         WHEN 0 THEN 'CONFIRMED'
         WHEN 3 THEN 'CANCELLED'
         WHEN 4 THEN 'CANCELLED'
         ELSE 'PENDING'
       END,
       CASE p.rn % 5
         WHEN 2 THEN now() - interval '2 hours'  -- lapsed: created 2h ago
         ELSE now()
       END,
       CASE p.rn % 5
         WHEN 2 THEN now() - interval '1 hour'   -- ...expired 1h ago
         ELSE now() + interval '15 minutes'
       END
FROM picked p;

INSERT INTO reservation_items (reservation_id, seat_id, claim_state, valid_during)
SELECT md5(p.seat_id::text)::uuid,
       p.seat_id,
       CASE p.rn % 5
         WHEN 0 THEN 'SOLD'
         WHEN 3 THEN 'RELEASED'
         WHEN 4 THEN 'RELEASED'
         ELSE 'HELD'
       END,
       CASE p.rn % 5
         WHEN 0 THEN tstzrange(now(), 'infinity')
         WHEN 1 THEN tstzrange(now(), now() + interval '15 minutes')
         WHEN 2 THEN tstzrange(now() - interval '2 hours', now() - interval '1 hour')
         ELSE      tstzrange(now() - interval '3 hours', now() - interval '2 hours')
       END
FROM picked p;

-- Orders for the SOLD claims ------------------------------------------------
INSERT INTO orders (id, reservation_id, state, total_minor, currency)
SELECT md5('order-' || p.seat_id::text)::uuid,
       md5(p.seat_id::text)::uuid,
       'PAID',
       5000,
       'GBP'
FROM picked p
WHERE p.rn % 5 = 0;

INSERT INTO order_lines (order_id, seat_id, seat_code, price_minor, currency)
SELECT md5('order-' || p.seat_id::text)::uuid,
       p.seat_id,
       s.code,
       s.price_minor,
       'GBP'
FROM picked p
JOIN seats s ON s.id = p.seat_id
WHERE p.rn % 5 = 0;

-- Ledger: 10 accounts, 50k balanced transactions → 100k entries -------------
INSERT INTO ledger_accounts (id, name, type, currency)
SELECT md5('acct-' || g)::uuid,
       CASE WHEN g <= 5 THEN 'cash-' || g ELSE 'revenue-' || g END,
       CASE WHEN g <= 5 THEN 'ASSET' ELSE 'REVENUE' END,
       'GBP'
FROM generate_series(1, 10) g;

INSERT INTO ledger_transactions (id, reference, currency)
SELECT md5('txn-' || g)::uuid, 'order-' || g, 'GBP'
FROM generate_series(1, 50000) g;

-- Deferred balance trigger fires at COMMIT, so both sides must land in the
-- same transaction — which psql gives us implicitly for a single statement.
INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
SELECT md5('txn-' || g)::uuid,
       md5('acct-' || (1 + (g % 5)))::uuid,
       'DEBIT',
       5000,
       'GBP'
FROM generate_series(1, 50000) g
UNION ALL
SELECT md5('txn-' || g)::uuid,
       md5('acct-' || (6 + (g % 5)))::uuid,
       'CREDIT',
       5000,
       'GBP'
FROM generate_series(1, 50000) g;

DROP TABLE picked;

-- Without fresh statistics the planner is guessing, and any before/after
-- comparison measures the guess rather than the index.
ANALYZE;

SELECT 'events' AS table, count(*) FROM events
UNION ALL SELECT 'seats', count(*) FROM seats
UNION ALL SELECT 'reservations', count(*) FROM reservations
UNION ALL SELECT 'reservation_items', count(*) FROM reservation_items
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'order_lines', count(*) FROM order_lines
UNION ALL SELECT 'ledger_entries', count(*) FROM ledger_entries;
