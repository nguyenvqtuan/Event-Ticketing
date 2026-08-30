import { z } from 'zod';

/**
 * The single source of truth for every environment variable the API reads.
 *
 * Anything not declared here is invisible to the app: `AppConfigService` is
 * the only sanctioned way to reach configuration, so adding a variable means
 * adding it to this schema first.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** HTTP port the API binds to. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Nest logger verbosity. */
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),

  /**
   * Postgres connection string. Deliberately has NO default — it is the
   * variable that proves the fail-fast behaviour, and a wrong default here
   * would silently point a deployment at the wrong database.
   */
  DATABASE_URL: z
    .string({ error: 'is required — see .env.example' })
    .min(1, 'is required — see .env.example')
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  /** How long a seat hold survives before expiring (TICK-4/TICK-5). */
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  /** Origin allowed to call the API from a browser. */
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3001'),

  /**
   * How long a shutdown waits for in-flight requests before giving up on them
   * (TICK-19).
   *
   * Must stay comfortably BELOW the orchestrator's own kill timeout — Kubernetes
   * `terminationGracePeriodSeconds` (default 30s), compose's `stop_grace_period`
   * — or the platform SIGKILLs the process mid-drain and the timeout never gets
   * to do its job. 10s against a 30s grace period leaves room for the pre-stop
   * delay as well. See docs/runbook.md.
   */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Passed to `ConfigModule.forRoot({ validate })`, so it runs during module
 * initialisation — before the HTTP server is listening. A failure here means
 * the process dies instead of serving traffic with bad configuration.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}\n`);
  }

  return result.data;
}
