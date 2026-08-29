import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';
import { AppConfigService } from '../../config/app-config.service.js';

/**
 * The small connection pool the health slice probes with, and the only place
 * in this slice that knows Postgres exists.
 *
 * Deliberately not `DatabaseModule`'s application pool: a probe that queues
 * behind saturated application traffic answers late or not at all, and an
 * orchestrator reads a timed-out readiness check as "down" — turning load
 * into an outage. Two connections, reserved for probing, with a connect
 * timeout so a wedged network fails the check instead of hanging it.
 */
@Injectable()
export class HealthDatabase implements OnApplicationShutdown {
  private readonly logger = new Logger(HealthDatabase.name);
  private readonly pool: Pool;

  constructor(config: AppConfigService) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
    });

    // A pool emits errors for idle clients dropped by the server; without a
    // listener those surface as unhandled exceptions and kill the process.
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle Postgres client error: ${error.message}`);
    });
  }

  async query<T extends QueryResultRow>(sql: string): Promise<T[]> {
    const { rows } = await this.pool.query<T>(sql);

    return rows;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
