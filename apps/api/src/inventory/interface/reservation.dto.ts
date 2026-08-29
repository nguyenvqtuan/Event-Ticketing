import { z } from 'zod';

/**
 * `holderId` is supplied by the client for now. Once authentication lands it
 * comes from the authenticated principal instead — a client must not be able
 * to hold seats on someone else's behalf.
 */
export const createReservationSchema = z.object({
  eventId: z.uuid(),
  holderId: z.uuid(),
  seatIds: z
    .array(z.uuid())
    .min(1, 'at least one seat is required')
    // Bounded so one request cannot lock an unlimited number of rows and
    // stall every other buyer for the duration of its transaction.
    .max(20, 'at most 20 seats per reservation')
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'seatIds must not contain duplicates',
    }),
});

export type CreateReservationDto = z.infer<typeof createReservationSchema>;

export const reservationIdSchema = z.uuid('must be a UUID');

/**
 * What the client believes it is paying. Checked against the seat prices, so a
 * stale client that saw an old price is rejected rather than silently charged
 * the new one. It is also the payload the idempotency key is hashed over —
 * reusing a key for a different amount is a client bug worth surfacing.
 */
export const payReservationSchema = z.object({
  amountMinor: z.int().nonnegative(),
  currency: z.string().length(3).toUpperCase(),
});

export type PayReservationDto = z.infer<typeof payReservationSchema>;
