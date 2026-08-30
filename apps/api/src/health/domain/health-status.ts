/**
 * Domain layer — plain TypeScript only.
 *
 * Nothing in this directory may import from `@nestjs/*`, an ORM, or a DB
 * driver. That is what keeps the domain testable in isolation and free to
 * outlive any framework choice.
 */

export type HealthState = 'ok' | 'degraded';

/** Immutable value object describing the service's liveness. */
export class HealthStatus {
  private constructor(
    readonly state: HealthState,
    readonly uptimeSeconds: number,
  ) {}

  static from(uptimeSeconds: number): HealthStatus {
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
      throw new Error(`uptimeSeconds must be a non-negative finite number, got: ${uptimeSeconds}`);
    }

    // A process that has only just come up is still warming its connections.
    const state: HealthState = uptimeSeconds < 1 ? 'degraded' : 'ok';

    return new HealthStatus(state, Math.floor(uptimeSeconds));
  }

  get isHealthy(): boolean {
    return this.state === 'ok';
  }
}
