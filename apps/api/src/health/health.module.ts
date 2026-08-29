import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { CheckHealthUseCase } from './application/check-health.use-case.js';
import { CheckReadinessUseCase } from './application/check-readiness.use-case.js';
import { HEALTH_PROBE, type HealthProbe } from './domain/health-probe.port.js';
import { MIGRATIONS_PROBE, type MigrationsProbe } from './domain/migrations-probe.port.js';
import { READINESS_PROBE, type ReadinessProbe } from './domain/readiness-probe.port.js';
import { HealthDatabase } from './infrastructure/health-database.js';
import { PostgresMigrationsProbe } from './infrastructure/postgres-migrations.probe.js';
import { PostgresReadinessProbe } from './infrastructure/postgres-readiness.probe.js';
import { ProcessUptimeProbe } from './infrastructure/process-uptime.probe.js';
import { HealthController } from './interface/health.controller.js';
import { LivenessIndicator } from './interface/liveness.indicator.js';
import { ReadinessIndicator } from './interface/readiness.indicator.js';

/**
 * Composition root for the slice. Wiring lives here so that the inner layers
 * stay free of framework imports:
 *
 *   interface → application → domain ← infrastructure
 *
 * `useFactory` lets the undecorated use cases receive their ports explicitly.
 * Terminus sits in the outermost ring only: the indicators translate a domain
 * status into its vocabulary, and nothing below `interface/` imports it.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    HealthDatabase,
    LivenessIndicator,
    ReadinessIndicator,
    { provide: HEALTH_PROBE, useClass: ProcessUptimeProbe },
    { provide: READINESS_PROBE, useClass: PostgresReadinessProbe },
    { provide: MIGRATIONS_PROBE, useClass: PostgresMigrationsProbe },
    {
      provide: CheckHealthUseCase,
      useFactory: (probe: HealthProbe) => new CheckHealthUseCase(probe),
      inject: [HEALTH_PROBE],
    },
    {
      provide: CheckReadinessUseCase,
      useFactory: (database: ReadinessProbe, migrations: MigrationsProbe) =>
        new CheckReadinessUseCase(database, migrations),
      inject: [READINESS_PROBE, MIGRATIONS_PROBE],
    },
  ],
})
export class HealthModule {}
