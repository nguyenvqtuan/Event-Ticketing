import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { CheckHealthUseCase } from '../application/check-health.use-case.js';

/**
 * Terminus indicator for liveness.
 *
 * Always reports `up`: liveness answers "should this process be restarted?",
 * and a process able to answer at all should not be. `state` is published for
 * the operator — a freshly booted instance reports `degraded` while it warms
 * up, which is information, not a reason to kill it.
 */
@Injectable()
export class LivenessIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly checkHealth: CheckHealthUseCase,
  ) {}

  check(): HealthIndicatorResult {
    const status = this.checkHealth.execute();

    return this.indicators
      .check('process')
      .up({ state: status.state, uptimeSeconds: status.uptimeSeconds });
  }
}
