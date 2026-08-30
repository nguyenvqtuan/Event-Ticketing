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
