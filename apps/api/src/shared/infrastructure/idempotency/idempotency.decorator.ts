import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENCY_REQUIRED = 'idempotency:required';

/**
 * Marks a route as requiring an `Idempotency-Key` header.
 *
 * Optional idempotency is fine for creating an event — a duplicate is
 * annoying. For a payment it is not: a client that retries after a timeout has
 * no way to know whether the first attempt charged, so the key is the only
 * thing standing between a network blip and a double charge. Making it
 * mandatory means a caller cannot accidentally opt out of that protection.
 */
export const RequireIdempotencyKey = () => SetMetadata(IDEMPOTENCY_REQUIRED, true);
