import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { type Response } from 'express';
import { CheckHealthUseCase } from '../application/check-health.use-case.js';
import { CheckReadinessUseCase } from '../application/check-readiness.use-case.js';

interface PingResponse {
  status: string;
  uptimeSeconds: number;
}

interface ReadyResponse {
  ready: boolean;
  dependencies: Readonly<Record<string, 'up' | 'down'>>;
}

/**
 * Interface layer — HTTP is a detail. This maps a request onto a use case and
 * a domain object onto a response body. No business rules live here.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly checkHealth: CheckHealthUseCase,
    private readonly checkReadiness: CheckReadinessUseCase,
  ) {}

  /** Liveness: is the process up? Touches nothing external. */
  @Get('ping')
  @HttpCode(HttpStatus.OK)
  ping(): PingResponse {
    const status = this.checkHealth.execute();

    return {
      status: status.state,
      uptimeSeconds: status.uptimeSeconds,
    };
  }

  /**
   * Readiness: can this instance serve traffic? Returns 503 when a dependency
   * is down, so an orchestrator removes it from rotation instead of
   * restarting it.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadyResponse> {
    const status = await this.checkReadiness.execute();

    response.status(status.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { ready: status.ready, dependencies: status.dependencies };
  }
}
