import {
  type CreateEventRequest,
  type CreateReservationRequest,
  type PayRequest,
} from '@repo/contracts';
import { createEventSchema, listSeatsQuerySchema } from './inventory/interface/event.dto.js';
import { createReservationSchema } from './inventory/interface/reservation.dto.js';
import { paySchema } from './payment/interface/payments.controller.js';

/**
 * Keeps `@repo/contracts` honest about REQUESTS.
 *
 * Responses are already guaranteed: the controllers are annotated with the
 * contract's response types, so a drifting response body is a compile error in
 * this package. Requests have no such anchor — the contract describes what a
 * client should send, and the Zod schemas decide what the server accepts. The
 * two could disagree, and the only symptom would be a 400 nobody predicted.
 *
 * So: build a value that satisfies the published request type, and push it
 * through the real schema. Add a required field to the schema without adding
 * it to the contract, and this fails.
 *
 * The schemas are deliberately NOT shared with clients — a server must never
 * trust a client, and shipping them would suggest a browser-side check is
 * load-bearing. This test is what replaces that shortcut.
 */
describe('@repo/contracts agrees with the schemas that enforce it', () => {
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  it('accepts a CreateEventRequest', () => {
    const request: CreateEventRequest = {
      name: 'Contract test',
      salesOpenAt: iso(-3_600_000),
      salesCloseAt: iso(30 * 86_400_000),
      startsAt: iso(31 * 86_400_000),
      seatMap: { rows: 2, seatsPerRow: 5 },
      priceMinor: 5_000,
      currency: 'GBP',
    };

    const result = createEventSchema.safeParse(request);

    expect(result.success).toBe(true);
  });

  it('parses the wire ISO strings into the Dates the use case expects', () => {
    const request: CreateEventRequest = {
      name: 'Coercion',
      salesOpenAt: '2027-01-01T00:00:00.000Z',
      salesCloseAt: '2027-06-01T00:00:00.000Z',
      startsAt: '2027-06-02T00:00:00.000Z',
      seatMap: { rows: 1, seatsPerRow: 1 },
      priceMinor: 100,
      currency: 'gbp',
    };

    const parsed = createEventSchema.parse(request);

    // The contract says string because that is what crosses the network; the
    // schema is where it stops being one.
    expect(parsed.startsAt).toBeInstanceOf(Date);
    expect(parsed.startsAt.toISOString()).toBe('2027-06-02T00:00:00.000Z');
    // Documented on the contract's `currency` field.
    expect(parsed.currency).toBe('GBP');
  });

  it('accepts a CreateReservationRequest', () => {
    const request: CreateReservationRequest = {
      eventId: '11111111-1111-4111-8111-111111111111',
      holderId: '22222222-2222-4222-8222-222222222222',
      seatIds: ['33333333-3333-4333-8333-333333333333'],
    };

    expect(createReservationSchema.safeParse(request).success).toBe(true);
  });

  it('accepts a PayRequest', () => {
    const request: PayRequest = { amountMinor: 10_000, currency: 'GBP' };

    expect(paySchema.safeParse(request).success).toBe(true);
  });

  it('accepts an omitted ListSeatsQuery and fills the documented defaults', () => {
    // The contract marks every field optional; the defaults it documents are
    // the server's, so they are asserted here rather than restated in prose.
    const parsed = listSeatsQuerySchema.parse({});

    expect(parsed).toEqual({ status: 'AVAILABLE', limit: 100, offset: 0 });
  });
});
