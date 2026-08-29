import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { LivenessIndicator } from './liveness.indicator.js';
import { ReadinessIndicator } from './readiness.indicator.js';

/**
 * Interface layer — HTTP is a detail. This maps a request onto a use case (via
 * a Terminus indicator) and its result onto a response body. No business rules
 * live here; Terminus owns the response shape and the 200/503 split.
 *
 * The two endpoints are deliberately distinct. A failing readiness check
 * should pull an instance out of rotation; a failing liveness check should
 * restart it. Conflating them turns a brief database blip into a restart loop.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly liveness: LivenessIndicator,
    private readonly readiness: ReadinessIndicator,
  ) {}

  /** Liveness: is the process up? Touches nothing external. */
  @Get('healthz')
  @HealthCheck()
  checkLiveness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.liveness.check()]);
  }

  /**
   * Readiness: can this instance serve traffic? 503 when Postgres is
   * unreachable or the schema is behind the migrations this build ships.
   */
  @Get('readyz')
  @HealthCheck()
  checkReadiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.readiness.check()]);
  }
}
