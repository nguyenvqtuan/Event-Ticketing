import { z } from 'zod';
import { MAX_SEATS_PER_EVENT } from '../domain/seat-map.js';

/**
 * Request schemas. `z.infer` gives the DTO type, so the type and the check
 * cannot drift apart the way a hand-written interface plus decorators can.
 *
 * These validate SHAPE. Rules that involve the domain — sales closing before
 * the event starts, the seat cap — stay in the aggregate and are re-checked
 * there; the duplication at the edge exists only to return a clear 400 rather
 * than letting a domain error surface as one.
 */
export const createEventSchema = z
  .object({
    name: z.string().trim().min(1, 'is required').max(200),
    startsAt: z.coerce.date(),
    salesOpenAt: z.coerce.date(),
    salesCloseAt: z.coerce.date(),
    seatMap: z.object({
      rows: z.int().positive().max(1_000),
      seatsPerRow: z.int().positive().max(1_000),
    }),
    priceMinor: z.int().nonnegative(),
    currency: z.string().length(3).toUpperCase(),
  })
  .refine((v) => v.salesCloseAt > v.salesOpenAt, {
    message: 'salesCloseAt must be after salesOpenAt',
    path: ['salesCloseAt'],
  })
  .refine((v) => v.salesCloseAt <= v.startsAt, {
    message: 'salesCloseAt must not be after startsAt',
    path: ['salesCloseAt'],
  })
  .refine((v) => v.seatMap.rows * v.seatMap.seatsPerRow <= MAX_SEATS_PER_EVENT, {
    message: `seat map may not exceed ${MAX_SEATS_PER_EVENT} seats`,
    path: ['seatMap'],
  });

export type CreateEventDto = z.infer<typeof createEventSchema>;

export const listSeatsQuerySchema = z.object({
  // Query strings arrive as text; the schema coerces so the controller gets
  // numbers and the defaults apply when a parameter is omitted.
  status: z.enum(['AVAILABLE', 'HELD', 'SOLD']).default('AVAILABLE'),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type ListSeatsQueryDto = z.infer<typeof listSeatsQuerySchema>;

export const eventIdSchema = z.uuid('must be a UUID');
