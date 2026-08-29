import { type HealthProbe } from '../domain/health-probe.port.js';
import { HealthStatus } from '../domain/health-status.js';

/**
 * Application layer — orchestrates the domain, still framework-free.
 *
 * Deliberately *not* decorated with `@Injectable()`. It is constructed by a
 * `useFactory` provider in `health.module.ts`, which keeps the dependency
 * arrow pointing inward and lets this class be unit-tested with a plain fake
 * and no Nest testing harness.
 */
export class CheckHealthUseCase {
  constructor(private readonly probe: HealthProbe) {}

  execute(): HealthStatus {
    return HealthStatus.from(this.probe.uptimeSeconds());
  }
}
