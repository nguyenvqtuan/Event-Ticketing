import { Injectable, Logger } from '@nestjs/common';
import { type ReadinessProbe } from '../domain/readiness-probe.port.js';
import { HealthDatabase } from './health-database.js';

/** Answers "can this instance still talk to Postgres?" and nothing more. */
@Injectable()
export class PostgresReadinessProbe implements ReadinessProbe {
  private readonly logger = new Logger(PostgresReadinessProbe.name);

  constructor(private readonly database: HealthDatabase) {}

  async isReachable(): Promise<boolean> {
    try {
      await this.database.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.warn(`Postgres unreachable: ${(error as Error).message}`);
      return false;
    }
  }
}
