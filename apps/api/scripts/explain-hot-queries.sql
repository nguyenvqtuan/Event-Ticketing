-- EXPLAIN ANALYZE for the hot queries. Run before and after index changes.
--
--   pnpm --filter @repo/api db:explain
--
-- Raw SQL on purpose: the plans must be unambiguous, not whatever an ORM
-- decided to emit today.

\timing off
\pset pager off

\set event_id '(SELECT id FROM events ORDER BY name LIMIT 1)'

\echo ''
\echo '================ Q1: available seats for an event ================'
-- The money query. A seat is available when no live claim covers it — there is
-- no status column to read (see docs/domain.md), so this is an anti-join
-- against claims whose validity period contains now().
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT s.id, s.code, s.price_minor
FROM seats s
WHERE s.event_id = (SELECT id FROM events ORDER BY name LIMIT 1)
  AND NOT EXISTS (
    SELECT 1
    FROM reservation_items ri
    WHERE ri.seat_id = s.id
      AND ri.claim_state <> 'RELEASED'
      AND ri.valid_during @> now()
  )
ORDER BY s.code
LIMIT 100;

\echo ''
\echo '================ Q1b: COUNT available seats (no LIMIT to hide behind) ================'
-- Q1 stops after 100 rows, so it never shows what the anti-join really costs.
-- Counting the whole event forces every seat to be probed — this is the shape
-- a seat-map render or an availability badge actually has.
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT count(*)
FROM seats s
WHERE s.event_id = (SELECT id FROM events ORDER BY name LIMIT 1)
  AND NOT EXISTS (
    SELECT 1
    FROM reservation_items ri
    WHERE ri.seat_id = s.id
      AND ri.claim_state <> 'RELEASED'
      AND ri.valid_during @> now()
  );

\echo ''
\echo '================ Q2: reservations for one holder ================'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, event_id, state, expires_at, created_at
FROM reservations
WHERE holder_id = (SELECT holder_id FROM reservations LIMIT 1)
ORDER BY created_at DESC
LIMIT 20;

\echo ''
\echo '================ Q3: ledger entries for one account ================'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, transaction_id, direction, amount_minor
FROM ledger_entries
WHERE account_id = (SELECT id FROM ledger_accounts ORDER BY name LIMIT 1)
ORDER BY created_at DESC
LIMIT 50;

\echo ''
\echo '================ Q4: sweep expired holds ================'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id
FROM reservations
WHERE state = 'PENDING'
  AND expires_at < now()
LIMIT 500;

\echo ''
\echo '================ Q5: is ONE seat available? ================'
-- Runs on every hold attempt, so it is the highest-frequency query here.
-- Served index-only by the GiST index backing the exclusion constraint —
-- that index does double duty as a read path.
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT EXISTS (
  SELECT 1 FROM reservation_items ri
  WHERE ri.seat_id = (SELECT id FROM seats ORDER BY code LIMIT 1)
    AND ri.claim_state <> 'RELEASED'
    AND ri.valid_during @> now()
);

\echo ''
\echo '================ index usage so far ================'
SELECT relname AS table, indexrelname AS index, idx_scan AS scans
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan, relname, indexrelname;
