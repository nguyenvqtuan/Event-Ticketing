-- Hand-written DDL that drizzle-kit cannot express.
--
-- Kept in its own migration on purpose: `drizzle-kit generate` REWRITES the
-- file it generated, so anything hand-added to 0000 is silently destroyed on
-- the next generate. Generated and hand-written migrations never share a file.

-- btree_gist supplies the equality operator class GiST needs for uuid, so
-- `seat_id WITH =` can share an index with a range-overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

--
-- THE DOUBLE-BOOKING CONSTRAINT.
--
-- A seat may be covered by at most one live claim at any instant.
--
-- Why not a unique partial index: a hold's liveness depends on the clock
-- ("expires_at > now()"), and an index predicate must be IMMUTABLE. now() is
-- STABLE, so Postgres rejects it outright. A predicate that omits time would
-- instead leave an expired hold blocking its seat forever, until a sweeper
-- wrote to the row — making correctness depend on a background job.
--
-- An exclusion constraint says it exactly: two rows conflict when they name
-- the same seat AND their validity periods overlap.
--
--   HELD → [created_at, expires_at)   ends by itself; no write needed
--   SOLD → [created_at, 'infinity')   never ends
--
-- RELEASED rows drop out of the constraint, so cancelling frees the seat at
-- once. Callers should expect SQLSTATE 23P01 and translate it to "seat no
-- longer available" rather than a 500.
--
ALTER TABLE "reservation_items"
  ADD CONSTRAINT "reservation_items_no_overlapping_claim"
  EXCLUDE USING gist ("seat_id" WITH =, "valid_during" WITH &&)
  WHERE ("claim_state" <> 'RELEASED');--> statement-breakpoint

-- An empty range would exclude nothing, quietly defeating the constraint.
ALTER TABLE "reservation_items"
  ADD CONSTRAINT "reservation_items_valid_during_not_empty"
  CHECK ("claim_state" = 'RELEASED' OR NOT isempty("valid_during"));--> statement-breakpoint

--
-- DOUBLE-ENTRY: debits must equal credits, per transaction.
--
-- This spans rows, so no CHECK can express it. A DEFERRABLE INITIALLY
-- DEFERRED constraint trigger runs at COMMIT, which lets a transaction insert
-- its entries one at a time and still be rejected as a whole if the result
-- does not balance. A non-deferred trigger would fire after the first insert,
-- when the transaction is trivially unbalanced.
--
CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  imbalance bigint;
  txn_id uuid;
BEGIN
  txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

  SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor
                           ELSE -amount_minor END), 0)
    INTO imbalance
    FROM ledger_entries
   WHERE transaction_id = txn_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced by % minor units', txn_id, imbalance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();
