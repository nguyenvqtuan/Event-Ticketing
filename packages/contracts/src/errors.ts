/**
 * The error bodies the API actually returns.
 *
 * There are three shapes, from three different places, and a client that
 * assumes one shape for everything will read `undefined` off the other two:
 *
 *   - `ZodValidationPipe` throws a 400 carrying field-level detail.
 *   - `DomainErrorFilter` maps domain errors onto status codes, and adds seat
 *     ids for the one error where the caller needs to know *which* seats went.
 *   - Nest's own exceptions (a bare `NotFoundException`) use its default shape.
 */

/** One field the request got wrong. Every problem is reported, not just the first. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** 400 from `ZodValidationPipe`. */
export interface ValidationErrorBody {
  readonly message: string;
  readonly errors: readonly FieldError[];
}

/**
 * 409 from `SeatsUnavailable` — the only error body carrying domain data.
 *
 * A caller that lost a race needs to know which seats went, so it can retry
 * with the rest rather than guess. `missingSeatIds` is the different failure:
 * seats that do not belong to this event at all.
 */
export interface SeatsUnavailableBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
  readonly unavailableSeatIds: readonly string[];
  readonly missingSeatIds: readonly string[];
}

/** What `DomainErrorFilter`, `PostgresErrorFilter` and Nest all have in common. */
export interface GenericErrorBody {
  readonly statusCode?: number;
  readonly error?: string;
  readonly message: string | readonly string[];
}

export type ApiErrorBody = ValidationErrorBody | SeatsUnavailableBody | GenericErrorBody;

export function isValidationErrorBody(body: unknown): body is ValidationErrorBody {
  return (
    typeof body === 'object' && body !== null && Array.isArray((body as ValidationErrorBody).errors)
  );
}

export function isSeatsUnavailableBody(body: unknown): body is SeatsUnavailableBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as SeatsUnavailableBody).unavailableSeatIds)
  );
}
