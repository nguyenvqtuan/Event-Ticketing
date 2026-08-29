import { type ReadinessProbe } from '../domain/readiness-probe.port.js';
import { ReadinessStatus } from '../domain/readiness-status.js';

/**
 * Framework-free, like every use case here. It knows there is a database
 * dependency; it does not know Postgres exists.
 */
export class CheckReadinessUseCase {
  constructor(private readonly database: ReadinessProbe) {}

  async execute(): Promise<ReadinessStatus> {
    const reachable = await this.database.isReachable();

    return ReadinessStatus.from({ database: reachable ? 'up' : 'down' });
  }
}
