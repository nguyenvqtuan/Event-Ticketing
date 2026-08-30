import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';

/**
 * `GET /events` and the seat map's `status=ALL`, added for TICK-F2 — the
 * frontend needs a collection to browse and a per-seat status to colour.
 *
 * A separate suite from `events.e2e-spec.ts` because these need control over
 * exactly which events exist, and that suite creates events freely.
 */
describe('Event listing and the seat map (e2e)', () => {
  let app: INestApplication;

  /**
   * Sales close the day before the event starts, derived rather than fixed:
   * the aggregate refuses `salesCloseAt` after `startsAt`, so a constant would
   * be invalid for any event scheduled earlier than it.
   */
  const event = (name: string, startsAt: string, overrides: Record<string, unknown> = {}) => ({
    name,
    startsAt,
    salesOpenAt: '2026-01-01T00:00:00.000Z',
    salesCloseAt: new Date(new Date(startsAt).getTime() - 86_400_000).toISOString(),
    seatMap: { rows: 1, seatsPerRow: 3 },
    priceMinor: 5000,
    currency: 'GBP',
    ...overrides,
  });

  const create = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/events').send(body).expect(201);

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /events', () => {
    it('returns an empty page rather than a 404 when there are no events', async () => {
      await resetDatabase();

      const response = await request(app.getHttpServer()).get('/events').expect(200);

      // An empty collection is a valid answer; the list page renders an empty
      // state from it. Only a missing *event* is a 404.
      expect(response.body).toEqual({
        events: [],
        pagination: { total: 0, limit: 20, offset: 0 },
      });
    });

    it('orders events by when they start, soonest first', async () => {
      await resetDatabase();

      // Created out of order on purpose.
      await create(event('Later', '2027-09-01T19:00:00.000Z'));
      await create(event('Sooner', '2027-03-01T19:00:00.000Z'));
      await create(event('Middle', '2027-06-01T19:00:00.000Z'));

      const response = await request(app.getHttpServer()).get('/events').expect(200);

      expect(response.body.events.map((e: { name: string }) => e.name)).toEqual([
        'Sooner',
        'Middle',
        'Later',
      ]);
    });

    it('reports whether each event is on sale, from the server clock', async () => {
      await resetDatabase();

      await create(
        event('Open now', '2027-06-01T19:00:00.000Z', {
          salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
          salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
      );
      // Sales open a month from now, so this one is not on sale yet. Stated
      // explicitly rather than relying on the helper's default, which opens
      // sales in the past.
      await create(
        event('Not yet', '2027-07-01T19:00:00.000Z', {
          salesOpenAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
      );

      const response = await request(app.getHttpServer()).get('/events').expect(200);
      const byName = Object.fromEntries(
        response.body.events.map((e: { name: string; onSale: boolean }) => [e.name, e.onSale]),
      );

      expect(byName).toEqual({ 'Open now': true, 'Not yet': false });
    });

    it('pages without dropping or repeating rows', async () => {
      await resetDatabase();

      for (let i = 1; i <= 5; i++) {
        await create(event(`Event ${i}`, `2027-0${i}-01T19:00:00.000Z`));
      }

      const first = await request(app.getHttpServer()).get('/events?limit=2&offset=0').expect(200);
      const second = await request(app.getHttpServer()).get('/events?limit=2&offset=2').expect(200);
      const third = await request(app.getHttpServer()).get('/events?limit=2&offset=4').expect(200);

      const names = [...first.body.events, ...second.body.events, ...third.body.events].map(
        (e: { name: string }) => e.name,
      );

      // Five distinct events across three pages: the ordering is a total one,
      // so nothing is skipped or seen twice.
      expect(names).toEqual(['Event 1', 'Event 2', 'Event 3', 'Event 4', 'Event 5']);
      expect(first.body.pagination).toEqual({ total: 5, limit: 2, offset: 0 });
    });

    it('rejects paging outside the documented bounds', async () => {
      await request(app.getHttpServer()).get('/events?limit=101').expect(400);
      await request(app.getHttpServer()).get('/events?limit=0').expect(400);
      await request(app.getHttpServer()).get('/events?offset=-1').expect(400);
    });

    it('does not shadow GET /events/:id', async () => {
      await resetDatabase();
      const created = await create(event('Routed', '2027-06-01T19:00:00.000Z'));

      // Both routes are declared on the same controller; order matters, and a
      // regression here would send one to the other.
      const detail = await request(app.getHttpServer())
        .get(`/events/${created.body.id}`)
        .expect(200);

      expect(detail.body.name).toBe('Routed');
    });
  });

  describe('GET /events/:id/seats?status=ALL', () => {
    /** Creates an event on sale now and returns its id and seat ids. */
    async function seedOnSale() {
      const created = await create(
        event('Seat map', '2027-06-01T19:00:00.000Z', {
          salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
          salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
      );

      const seats = await request(app.getHttpServer())
        .get(`/events/${created.body.id}/seats?status=ALL`)
        .expect(200);

      return {
        eventId: created.body.id as string,
        seatIds: (seats.body.seats as { id: string }[]).map((s) => s.id),
      };
    }

    it('returns every seat with its status, which is what a map draws', async () => {
      await resetDatabase();
      const { eventId, seatIds } = await seedOnSale();

      // One held, one sold, one left alone — all three states at once.
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds: [seatIds[0]] })
        .expect(201);

      const held = await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds: [seatIds[1]] })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/reservations/${held.body.id}/pay`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: 5000, currency: 'GBP' })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats?status=ALL`)
        .expect(200);

      const byId = Object.fromEntries(
        (response.body.seats as { id: string; status: string }[]).map((s) => [s.id, s.status]),
      );

      expect(response.body.seats).toHaveLength(3);
      expect(byId[seatIds[0]!]).toBe('HELD');
      expect(byId[seatIds[1]!]).toBe('SOLD');
      expect(byId[seatIds[2]!]).toBe('AVAILABLE');
    });

    it('carries the status on a filtered page too', async () => {
      await resetDatabase();
      const { eventId } = await seedOnSale();

      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats?status=AVAILABLE`)
        .expect(200);

      // Additive: existing callers get a field they can ignore, and the map
      // does not have to ask three times to learn three states.
      expect(response.body.seats.every((s: { status: string }) => s.status === 'AVAILABLE')).toBe(
        true,
      );
    });

    it('still defaults to AVAILABLE when no status is given', async () => {
      await resetDatabase();
      const { eventId, seatIds } = await seedOnSale();

      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds: [seatIds[0]] })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats`)
        .expect(200);

      // The default is unchanged by TICK-F2 — this widened the endpoint
      // rather than altering what existing callers already receive.
      expect(response.body.seats).toHaveLength(2);
      expect(response.body.pagination.total).toBe(2);
    });

    it('rejects a status it does not know', async () => {
      const { eventId } = await seedOnSale();

      await request(app.getHttpServer()).get(`/events/${eventId}/seats?status=NOPE`).expect(400);
    });
  });
});
