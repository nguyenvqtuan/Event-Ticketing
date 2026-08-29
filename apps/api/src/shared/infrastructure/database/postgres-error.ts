/** Postgres SQLSTATEs this application reacts to by name. */
export const UNIQUE_VIOLATION = '23505';
export const EXCLUSION_VIOLATION = '23P01';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * Finds the Postgres error inside whatever wrapped it.
 *
 * Drizzle rethrows driver errors wrapped in its own `Error`, putting the real
 * one on `cause`. Checking `error.code` on the outer object therefore silently
 * misses every constraint violation — which is exactly what happened when the
 * idempotency interceptor stopped recognising duplicate keys and returned 500
 * instead of replaying. Walk the chain rather than trusting the top level.
 */
export function findPostgresError(error: unknown): PostgresError | null {
  let current: unknown = error;

  // Bounded: a cause chain should be short, and a cycle must not hang us.
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (typeof (current as PostgresError).code === 'string') {
      return current as PostgresError;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

export function isPostgresErrorWithCode(error: unknown, ...codes: string[]): boolean {
  const pg = findPostgresError(error);

  return pg !== null && pg.code !== undefined && codes.includes(pg.code);
}
