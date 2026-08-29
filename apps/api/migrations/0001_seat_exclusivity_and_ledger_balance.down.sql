-- Reverses 0001_seat_exclusivity_and_ledger_balance.sql.

DROP TRIGGER IF EXISTS ledger_entries_balanced ON "ledger_entries";--> statement-breakpoint
DROP FUNCTION IF EXISTS assert_ledger_balanced();--> statement-breakpoint

ALTER TABLE "reservation_items"
  DROP CONSTRAINT IF EXISTS "reservation_items_valid_during_not_empty";--> statement-breakpoint
ALTER TABLE "reservation_items"
  DROP CONSTRAINT IF EXISTS "reservation_items_no_overlapping_claim";--> statement-breakpoint

-- btree_gist is deliberately NOT dropped. Extensions are database-wide and
-- other schemas may depend on it; a rollback should not take down more than
-- it owns.
