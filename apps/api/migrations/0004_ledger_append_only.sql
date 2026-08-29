-- Hand-written: append-only enforcement and the chart of accounts.
-- (Generated and hand-written migrations never share a file — see 0001.)

--
-- APPEND-ONLY LEDGER.
--
-- A ledger you can edit is not an audit trail. Corrections are made by posting
-- a REVERSING transaction, never by changing history — otherwise "what did we
-- charge?" has no answer you can trust, and a bug or a bad migration can
-- rewrite the past silently.
--
-- Enforced in the database rather than by convention, because the whole point
-- is to be safe from code that does not know the rule: a future feature, a
-- data fix, a psql session.
--
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % is not permitted. Post a reversing transaction instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();--> statement-breakpoint

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();--> statement-breakpoint

--
-- An account is identified by name AND currency: "cash" in GBP and "cash" in
-- EUR are different accounts, and mixing them is exactly the mistake Money
-- refuses to make in the domain. The original unique(name) made that
-- unrepresentable.
--
DROP INDEX IF EXISTS "ledger_accounts_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_name_currency_uq"
  ON "ledger_accounts" ("name", "currency");--> statement-breakpoint

--
-- Chart of accounts. Reference data, so it belongs in a migration rather than
-- being conjured at runtime — an accounting system that invents accounts on
-- demand cannot be reconciled.
--
INSERT INTO "ledger_accounts" ("name", "type", "currency")
SELECT a.name, a.type, c.currency
FROM (VALUES
        ('cash',           'ASSET'),
        ('ticket_revenue', 'REVENUE')
     ) AS a(name, type)
CROSS JOIN (VALUES ('GBP'), ('EUR'), ('USD')) AS c(currency)
ON CONFLICT DO NOTHING;
