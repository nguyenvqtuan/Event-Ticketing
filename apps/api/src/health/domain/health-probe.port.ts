/**
 * A port: the domain states what it needs, an adapter in `infrastructure/`
 * supplies it. The domain never learns how uptime is actually measured.
 *
 * TICK-4's repositories follow exactly this shape — an interface here, a
 * concrete ORM-backed class in `infrastructure/`, bound in the module.
 */
export interface HealthProbe {
  /** Seconds the service has been running. */
  uptimeSeconds(): number;
}

/**
 * DI token. Interfaces vanish at compile time, so Nest cannot inject by
 * interface — it needs a runtime value to key the provider on.
 */
export const HEALTH_PROBE = Symbol('HEALTH_PROBE');
