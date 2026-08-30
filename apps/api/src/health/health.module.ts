import { Module } from '@nestjs/common';
import { CheckHealthUseCase } from './application/check-health.use-case.js';
import { CheckReadinessUseCase } from './application/check-readiness.use-case.js';
import { HEALTH_PROBE, type HealthProbe } from './domain/health-probe.port.js';
import { READINESS_PROBE, type ReadinessProbe } from './domain/readiness-probe.port.js';
import { ProcessUptimeProbe } from './infrastructure/process-uptime.probe.js';
import { PostgresReadinessProbe } from './infrastructure/postgres-readiness.probe.js';
import { HealthController } from './interface/health.controller.js';

/**
 * Composition root for the slice. Wiring lives here so that the inner layers
 * stay free of framework imports:
 *
 *   interface → application → domain ← infrastructure
 *
 * `useFactory` lets the undecorated use cases receive their ports explicitly.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: HEALTH_PROBE, useClass: ProcessUptimeProbe },
    { provide: READINESS_PROBE, useClass: PostgresReadinessProbe },
    {
      provide: CheckHealthUseCase,
      useFactory: (probe: HealthProbe) => new CheckHealthUseCase(probe),
      inject: [HEALTH_PROBE],
    },
    {
      provide: CheckReadinessUseCase,
      useFactory: (probe: ReadinessProbe) => new CheckReadinessUseCase(probe),
      inject: [READINESS_PROBE],
    },
  ],
})
export class HealthModule {}
