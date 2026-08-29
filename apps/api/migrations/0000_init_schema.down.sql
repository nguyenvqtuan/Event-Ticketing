-- Reverses 0000_init_schema.sql.
--
-- drizzle-kit does not generate down migrations, so these are written by hand
-- and exercised by `pnpm db:reset` (up → down all → up on an empty database).
--
-- Order matters: children before parents, since most foreign keys are
-- RESTRICT rather than CASCADE.

DROP TABLE IF EXISTS "processed_events";--> statement-breakpoint
DROP TABLE IF EXISTS "idempotency_keys";--> statement-breakpoint
DROP TABLE IF EXISTS "ledger_entries";--> statement-breakpoint
DROP TABLE IF EXISTS "ledger_transactions";--> statement-breakpoint
DROP TABLE IF EXISTS "ledger_accounts";--> statement-breakpoint
DROP TABLE IF EXISTS "order_lines";--> statement-breakpoint
DROP TABLE IF EXISTS "orders";--> statement-breakpoint
DROP TABLE IF EXISTS "reservation_items";--> statement-breakpoint
DROP TABLE IF EXISTS "reservations";--> statement-breakpoint
DROP TABLE IF EXISTS "seats";--> statement-breakpoint
DROP TABLE IF EXISTS "events";
