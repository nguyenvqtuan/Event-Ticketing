import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  readonly correlationId: string;
}

/**
 * Carries the correlation ID for the current request.
 *
 * The alternative is threading the ID through every function signature, which
 * fails the moment a layer that has no business knowing about HTTP needs to
 * log — and our use cases are deliberately framework-free, so they never see
 * a request object at all.
 *
 * AsyncLocalStorage keeps the value attached to the async execution context
 * instead, so a repository four calls below the controller reads the same ID
 * without anyone passing it down. The same mechanism carries the database
 * transaction (see DatabaseModule).
 */
const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `work` with a correlation ID bound to the current async context. */
export function runWithCorrelationId<T>(correlationId: string, work: () => T): T {
  return storage.run({ correlationId }, work);
}

/**
 * The current correlation ID, or undefined outside a request.
 *
 * Undefined is legitimate: startup logs and the expiry sweeper's cron ticks
 * have no request to correlate with, and inventing an ID for them would imply
 * a caller that does not exist.
 */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
