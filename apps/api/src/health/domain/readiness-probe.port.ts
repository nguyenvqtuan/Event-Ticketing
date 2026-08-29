/**
 * A port for "can this instance serve traffic?" — distinct from liveness.
 *
 * Liveness ("is the process up?") is answered without touching the network.
 * Readiness depends on the things the process needs, starting with the
 * database. Keeping them separate matters operationally: a failing readiness
 * check should pull an instance out of rotation, not restart it.
 */
export interface ReadinessProbe {
  /** Resolves true when the dependency is reachable and responsive. */
  isReachable(): Promise<boolean>;
}

/** DI token — interfaces do not survive compilation. */
export const READINESS_PROBE = Symbol('READINESS_PROBE');
