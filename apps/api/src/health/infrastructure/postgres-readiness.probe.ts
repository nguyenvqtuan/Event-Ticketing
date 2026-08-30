import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../../config/app-config.service.js';
import { type ReadinessProbe } from '../domain/readiness-probe.port.js';

/**
 * The only place in the codebase that knows Postgres exists.
 *
 * TICK-5 will introduce a proper connection/unit-of-work abstraction; for now
 * this owns a small pool purely so the API can prove it reaches the database,
 * which is what TICK-3's compose healthcheck asserts.
 */
@Injectable()
export class PostgresReadinessProbe implements ReadinessProbe, OnApplicationShutdown {
  private readonly logger = new Logger(PostgresReadinessProbe.name);
  private readonly pool: Pool;

  constructor(config: AppConfigService) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 2,
      // Fail the check rather than let a healthcheck hang on a wedged network.
      connectionTimeoutMillis: 2_000,
    });

    // A pool emits errors for idle clients dropped by the server; without a
    // listener those surface as unhandled exceptions and kill the process.
    this.pool.on('error', (error) => {
      this.logger.warn(`Idle Postgres client error: ${error.message}`);
    });
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.warn(`Postgres unreachable: ${(error as Error).message}`);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
