import { Controller, Get } from '@nestjs/common';
import { CheckHealthUseCase } from '../application/check-health.use-case.js';

interface PingResponse {
  status: string;
  uptimeSeconds: number;
}

/**
 * Interface layer — HTTP is a detail. This maps a request onto a use case and
 * a domain object onto a response body. No business rules live here.
 */
@Controller()
export class HealthController {
  constructor(private readonly checkHealth: CheckHealthUseCase) {}

  @Get('ping')
  ping(): PingResponse {
    const status = this.checkHealth.execute();

    return {
      status: status.state,
      uptimeSeconds: status.uptimeSeconds,
    };
  }
}
