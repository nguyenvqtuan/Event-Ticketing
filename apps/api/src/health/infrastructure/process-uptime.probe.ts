import { Injectable } from '@nestjs/common';
import { type HealthProbe } from '../domain/health-probe.port.js';

/**
 * Infrastructure layer — where the outside world is allowed in.
 *
 * This is the only file in the slice that knows uptime comes from the Node
 * process. Swapping it for a DB-backed probe in TICK-3 touches nothing else.
 */
@Injectable()
export class ProcessUptimeProbe implements HealthProbe {
  uptimeSeconds(): number {
    return process.uptime();
  }
}
