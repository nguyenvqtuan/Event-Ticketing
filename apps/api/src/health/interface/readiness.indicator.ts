import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { CheckReadinessUseCase } from '../application/check-readiness.use-case.js';

/**
 * Terminus indicator for readiness.
 *
 * Reports one result per dependency — `database` and `migrations` — so the
 * response names what is wrong rather than just saying "not ready". Both come
 * from a single use-case call: the two checks share a round trip, and running
 * them apart could report a schema verdict for a database that has since gone.
 */
@Injectable()
export class ReadinessIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly checkReadiness: CheckReadinessUseCase,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    const status = await this.checkReadiness.execute();

    const database = this.indicators.check('database');
    const migrations = this.indicators.check('migrations');

    return {
      ...(status.dependencies.database === 'up' ? database.up() : database.down()),
      ...(status.dependencies.migrations === 'up'
        ? migrations.up()
        : migrations.down({ pending: status.pendingMigrations })),
    };
  }
}
