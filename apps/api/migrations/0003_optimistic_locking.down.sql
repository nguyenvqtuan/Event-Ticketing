-- Reverses 0003_optimistic_locking.sql.
--
-- Safe to drop: `version` carries no business data, only concurrency
-- bookkeeping. Rolling back loses the counters, not any state.

ALTER TABLE "orders" DROP COLUMN IF EXISTS "version";--> statement-breakpoint
ALTER TABLE "reservations" DROP COLUMN IF EXISTS "version";
