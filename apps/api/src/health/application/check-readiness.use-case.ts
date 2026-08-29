import { type MigrationsProbe } from '../domain/migrations-probe.port.js';
import { type ReadinessProbe } from '../domain/readiness-probe.port.js';
import { ReadinessStatus } from '../domain/readiness-status.js';

/**
 * Framework-free, like every use case here. It knows there is a database
 * dependency and that this build expects a particular schema; it does not
 * know Postgres exists.
 */
export class CheckReadinessUseCase {
  constructor(
    private readonly database: ReadinessProbe,
    private readonly migrations: MigrationsProbe,
  ) {}

  async execute(): Promise<ReadinessStatus> {
    if (!(await this.database.isReachable())) {
      // The migration ledger is a table. With the database unreachable the
      // schema version is unknown, and unknown is not ready.
      return ReadinessStatus.from({ database: 'down', migrations: 'down' });
    }

    const pending = await this.migrations.pendingVersions();

    return ReadinessStatus.from(
      { database: 'up', migrations: pending.length === 0 ? 'up' : 'down' },
      pending,
    );
  }
}
