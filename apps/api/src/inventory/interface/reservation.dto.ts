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
