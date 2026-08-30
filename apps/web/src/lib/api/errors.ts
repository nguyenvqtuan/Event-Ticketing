import {
  type ApiErrorBody,
  type FieldError,
  isSeatsUnavailableBody,
  isValidationErrorBody,
} from '@repo/contracts';

/**
 * Typed failures the UI can branch on.
 *
 * The alternative — returning `{ ok: false, status: 409 }` and letting each
 * component re-derive meaning from a number — spreads knowledge of the API's
 * status codes across every screen. Here it is decided once, at the edge.
 *
 * Both `instanceof` and a `kind` discriminant are available: `kind` because a
 * `switch` on it is exhaustively checked by TypeScript, which is what makes an
 * unhandled case a build error rather than a blank screen.
 */
export type ApiErrorKind =
  'validation' | 'conflict' | 'unprocessable' | 'not-found' | 'server' | 'network';

export abstract class ApiError extends Error {
  abstract readonly kind: ApiErrorKind;

  constructor(
    message: string,
    /** Present for every failure that reached the server. */
    readonly status: number | null,
    readonly body: ApiErrorBody | null,
    /**
     * The id this request was logged under, echoed by the API. Worth showing
     * in an error state: it is what turns "it broke" into a searchable log.
     */
    readonly correlationId: string | null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — the request was malformed. Carries which fields, and why. */
export class ValidationError extends ApiError {
  readonly kind = 'validation' as const;

  constructor(
    message: string,
    readonly fieldErrors: readonly FieldError[],
    status: number,
    body: ApiErrorBody | null,
    correlationId: string | null,
  ) {
    super(message, status, body, correlationId);
  }

  /** Field name → message, for rendering errors beside inputs. */
  byField(): Record<string, string> {
    return Object.fromEntries(this.fieldErrors.map((e) => [e.field, e.message]));
  }
}

/**
 * 409 — the request was valid but reality moved: a seat went, a hold expired,
 * an order was already refunded.
 *
 * `unavailableSeatIds` is populated only when the API says which seats lost;
 * the same status also covers "sales are closed" and "this hold is not
 * PENDING", which carry no seat ids. Check for emptiness rather than assuming.
 */
export class ConflictError extends ApiError {
  readonly kind = 'conflict' as const;

  constructor(
    message: string,
    readonly unavailableSeatIds: readonly string[],
    readonly missingSeatIds: readonly string[],
    status: number,
    body: ApiErrorBody | null,
    correlationId: string | null,
  ) {
    super(message, status, body, correlationId);
  }
}

/** 422 — well-formed and schema-valid, but the domain refused it (a wrong amount). */
export class UnprocessableError extends ApiError {
  readonly kind = 'unprocessable' as const;
}

/** 404 — no such event, reservation or order. */
export class NotFoundError extends ApiError {
  readonly kind = 'not-found' as const;
}

/** 5xx, or any status this client does not model. */
export class ServerError extends ApiError {
  readonly kind = 'server' as const;
}

/**
 * The request never produced an answer — offline, DNS, CORS, a timeout.
 *
 * Distinct from `ServerError` because it is the one case where the request may
 * still have been processed. That matters for anything paying: retrying is
 * safe only under the same `Idempotency-Key`.
 */
export class NetworkError extends ApiError {
  readonly kind = 'network' as const;

  // `override`: Error already declares `cause` (ES2022). Narrowing it here is
  // deliberate — the underlying TypeError is what says whether this was DNS,
  // CORS or a timeout.
  constructor(
    message: string,
    correlationId: string | null,
    override readonly cause?: unknown,
  ) {
    super(message, null, null, correlationId);
  }
}

/** Reads the API's message field, whatever shape the body arrived in. */
function messageOf(body: ApiErrorBody | null, fallback: string): string {
  if (body && 'message' in body && body.message) {
    return Array.isArray(body.message) ? body.message.join('; ') : String(body.message);
  }
  return fallback;
}

/** Maps a failed response onto the error the UI branches on. */
export function toApiError(
  status: number,
  body: ApiErrorBody | null,
  correlationId: string | null,
): ApiError {
  const message = messageOf(body, `Request failed with status ${status}`);

  if (status === 400 && isValidationErrorBody(body)) {
    return new ValidationError(message, body.errors, status, body, correlationId);
  }

  if (status === 409) {
    const seats = isSeatsUnavailableBody(body)
      ? { unavailable: body.unavailableSeatIds, missing: body.missingSeatIds }
      : { unavailable: [], missing: [] };

    return new ConflictError(
      message,
      seats.unavailable,
      seats.missing,
      status,
      body,
      correlationId,
    );
  }

  if (status === 404) return new NotFoundError(message, status, body, correlationId);
  if (status === 422) return new UnprocessableError(message, status, body, correlationId);

  // 400 without the field-level shape, and everything else, including 5xx.
  return new ServerError(message, status, body, correlationId);
}
