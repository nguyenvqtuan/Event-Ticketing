/**
 * Migration runner.
 *
 * drizzle-kit generates the forward SQL; it does not apply it and does not
 * write down migrations. This runner does both, so every change is a
 * reviewed, versioned file and a rollback is a first-class operation.
 *
 *   node --experimental-strip-types scripts/migrate.ts up
 *   node --experimental-strip-types scripts/migrate.ts down       # last only
 *   node --experimental-strip-types scripts/migrate.ts down all   # everything
 *   node --experimental-strip-types scripts/migrate.ts status
 *
 * Each migration runs inside a transaction: Postgres does transactional DDL,
 * so a failure half-way leaves nothing behind.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

/** Splits on drizzle's marker; plain ';' would break the plpgsql function body. */
const statementsOf = (sqlText: string): string[] =>
  sqlText
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !/^(--[^\n]*\n?)+$/.test(statement));

async function migrationVersions(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);

  return files
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .map((file) => file.replace(/\.sql$/, ''))
    .sort();
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );

  return new Set(rows.map((row) => row.version));
}

async function runFile(client: Client, file: string, version: string, record: boolean) {
  const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

  await client.query('BEGIN');
  try {
    for (const statement of statementsOf(sqlText)) {
      await client.query(statement);
    }

    await client.query(
      record
        ? 'INSERT INTO schema_migrations (version) VALUES ($1)'
        : 'DELETE FROM schema_migrations WHERE version = $1',
      [version],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function up(client: Client): Promise<void> {
  const applied = await appliedVersions(client);
  const pending = (await migrationVersions()).filter((version) => !applied.has(version));

  if (pending.length === 0) {
    console.log('up: nothing pending');
    return;
  }

  for (const version of pending) {
    console.log(`up: applying ${version}`);
    await runFile(client, `${version}.sql`, version, true);
  }

  console.log(`up: applied ${pending.length} migration(s)`);
}

/** Reverts the most recent migration, or every one when `all` is true. */
async function down(client: Client, all: boolean): Promise<void> {
  const applied = [...(await appliedVersions(client))].sort().reverse();
  const targets = all ? applied : applied.slice(0, 1);

  if (targets.length === 0) {
    console.log('down: nothing to revert');
    return;
  }

  // Newest first: 0001 undoes constraints that 0000's tables still carry.
  for (const version of targets) {
    console.log(`down: reverting ${version}`);
    await runFile(client, `${version}.down.sql`, version, false);
  }

  console.log(`down: reverted ${targets.length} migration(s)`);
}

async function status(client: Client): Promise<void> {
  const applied = await appliedVersions(client);

  for (const version of await migrationVersions()) {
    console.log(`  ${applied.has(version) ? '[applied]' : '[pending]'} ${version}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is required — see apps/api/.env.example');
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(LEDGER_TABLE);

    if (command === 'up') await up(client);
    else if (command === 'down') await down(client, process.argv[3] === 'all');
    else if (command === 'status') await status(client);
    else throw new Error(`Unknown command: ${command} (expected up | down [all] | status)`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`migration failed: ${(error as Error).message}`);
  process.exit(1);
});
