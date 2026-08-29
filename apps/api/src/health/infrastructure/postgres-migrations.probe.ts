import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import { type MigrationsProbe } from '../domain/migrations-probe.port.js';
import { HealthDatabase } from './health-database.js';

/**
 * Compares the migrations this build ships against the ledger
 * `scripts/migrate.ts` writes (`schema_migrations`).
 *
 * Both halves are needed: the image carries the SQL it was written against,
 * the database records what it has actually run. When they disagree the
 * deploy is half-done — new code, old schema — and this instance must stay
 * out of rotation until the migration lands.
 */

/**
 * `<apps/api>/migrations`, from `src/health/infrastructure` when running from
 * source and from `dist/health/infrastructure` in the image alike — the two
 * sit at the same depth, which is why the runtime stage copies the directory
 * next to `dist`.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

/** Same rule as the runner: forward files only, `NNNN_name.sql`. */
async function shippedVersions(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);

  return files
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .map((file) => file.replace(/\.sql$/, ''))
    .sort();
}

@Injectable()
export class PostgresMigrationsProbe implements MigrationsProbe {
  private readonly logger = new Logger(PostgresMigrationsProbe.name);
  /** The files cannot change under a running build, so read them once. */
  private shipped?: Promise<string[]>;

  constructor(private readonly database: HealthDatabase) {}

  async pendingVersions(): Promise<readonly string[]> {
    const shipped = await (this.shipped ??= shippedVersions());
    const applied = await this.appliedVersions(shipped);

    return shipped.filter((version) => !applied.has(version));
  }

  /**
   * Never throws: an unreadable ledger is reported as nothing applied, so the
   * endpoint answers 503 rather than 500. `shipped` is only used to name what
   * could not be verified in the log.
   */
  private async appliedVersions(shipped: readonly string[]): Promise<Set<string>> {
    try {
      const rows = await this.database.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );

      return new Set(rows.map((row) => row.version));
    } catch (error) {
      // 42P01 undefined_table: a database nothing has ever been applied to.
      // Every shipped version is genuinely pending, which is what an empty
      // set produces — no need to shout about it.
      if ((error as { code?: string }).code !== '42P01') {
        this.logger.warn(
          `Cannot read schema_migrations, treating all ${shipped.length} migration(s) as pending: ${(error as Error).message}`,
        );
      }

      return new Set();
    }
  }
}
