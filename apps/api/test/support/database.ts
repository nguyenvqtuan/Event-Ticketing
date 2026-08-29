import { Client } from 'pg';

/**
 * Reference data, not test data: the chart of accounts arrives in migration
 * 0004 and the ledger's foreign keys depend on it. Truncating it would leave
 * the schema valid but the system unable to post a transaction.
 */
const PRESERVED_TABLES = ['schema_migrations', 'ledger_accounts'];

/**
 * Empties every transactional table, for a suite that wants a clean slate
 * rather than fixtures namespaced by UUID.
 *
 * `TRUNCATE` rather than `DELETE`: it is faster, resets sequences, and — being
 * a table-level operation — does not fire the row triggers that make
 * `ledger_entries` append-only. That exemption is deliberate and confined to
 * the harness; nothing in the application can delete a ledger entry.
 */
export async function resetDatabase(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('resetDatabase: DATABASE_URL is not set — is global setup running?');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> ALL($1::text[])`,
      [PRESERVED_TABLES],
    );

    if (rows.length === 0) return;

    // One statement: CASCADE plus a single lock acquisition, so concurrent
    // foreign keys cannot deadlock the reset against itself.
    await client.query(
      `TRUNCATE TABLE ${rows.map((row) => `"${row.table_name}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await client.end();
  }
}
