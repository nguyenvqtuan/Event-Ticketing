/**
 * Base class for every rule the domain refuses to break.
 *
 * The domain throws these instead of HTTP exceptions so it stays free of the
 * framework; the interface layer is responsible for mapping them onto status
 * codes. That mapping is deliberately not here.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An operation was attempted that the aggregate's current state forbids. */
export class InvalidStateTransition extends DomainError {}

/** Input violated an invariant at construction time. */
export class InvariantViolation extends DomainError {}

/**
 * Someone else changed this aggregate between our read and our write.
 *
 * Optimistic concurrency: rather than holding a lock across the think-time
 * between reading and writing, the write asserts the version it read. A
 * mismatch means the update would have been lost, so it is rejected and the
 * caller re-reads and retries. See docs/concurrency.md.
 */
export class ConcurrentModification extends DomainError {
  constructor(
    readonly aggregate: string,
    readonly id: string,
  ) {
    super(`${aggregate} ${id} was modified concurrently — re-read it and retry`);
  }
}
