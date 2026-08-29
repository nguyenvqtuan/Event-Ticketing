-- Reverses 0004_ledger_append_only.sql.

DROP TRIGGER IF EXISTS ledger_entries_no_delete ON "ledger_entries";--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";--> statement-breakpoint
DROP FUNCTION IF EXISTS reject_ledger_mutation();--> statement-breakpoint

-- Remove only the chart-of-accounts rows this migration seeded, and only
-- where nothing references them. Ledger entries are never deleted to make a
-- rollback tidy — that is the one thing an append-only ledger must not do.
DELETE FROM "ledger_accounts" a
 WHERE a.name IN ('cash', 'ticket_revenue')
   AND NOT EXISTS (SELECT 1 FROM "ledger_entries" e WHERE e.account_id = a.id);--> statement-breakpoint

DROP INDEX IF EXISTS "ledger_accounts_name_currency_uq";
--
-- `unique(name)` is deliberately NOT recreated.
--
-- A rollback may RELAX a constraint but must never re-tighten one: the
-- forward migration legitimately created rows (cash/GBP, cash/EUR, cash/USD)
-- that the narrower constraint forbids, so recreating it fails outright — and
-- it fails *after* the triggers are already gone, leaving the schema
-- half-reverted.
--
-- This is the expand/contract rule from docs/db.md seen from the other side:
-- widening is reversible, narrowing is not. If the old constraint is genuinely
-- wanted back, that is a new forward migration that first resolves the
-- duplicates it would reject.
--
