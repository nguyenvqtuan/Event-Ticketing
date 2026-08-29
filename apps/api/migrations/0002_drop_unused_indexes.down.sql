-- Reverses 0002_drop_unused_indexes.sql.
--
-- Recreates two indexes TICK-6 measured at zero scans. Kept reversible so a
-- rollback restores the previous schema exactly, even though neither index is
-- justified by a query.

CREATE INDEX "events_on_sale_idx" ON "events" USING btree ("sales_open_at","sales_close_at");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_idx" ON "ledger_transactions" USING btree ("reference");
