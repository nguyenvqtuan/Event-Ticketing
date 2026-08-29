import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';

/**
 * Integration tests for TICK-7's endpoints, against a real Postgres —
 * provisioned and migrated by test/support/global-setup.ts, so `pnpm test:e2e`
 * is the whole setup.
 */
describe('Events endpoints (e2e)', () => {
  let app: INestApplication;

  const validEvent = (overrides: Record<string, unknown> = {}) => ({
    name: `Test Event ${randomUUID()}`,
    startsAt: '2027-06-01T19:00:00.000Z',
    salesOpenAt: '2027-01-01T00:00:00.000Z',
    salesCloseAt: '2027-06-01T00:00:00.000Z',
    seatMap: { rows: 3, seatsPerRow: 10 },
    priceMinor: 5000,
    currency: 'GBP',
    ...overrides,
  });

  // A clean database per suite: worker databases are reused across the
  // suites a worker runs, and one suite's rows are another's noise.
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

  describe('POST /events', () => {
    it('creates the event and generates its seats', async () => {
      const response = await request(app.getHttpServer())
        .post('/events')
        .send(validEvent())
        .expect(201);

      expect(response.body).toEqual({
        id: expect.any(String) as string,
        seatsCreated: 30,
        totalSeats: 30,
      });
    });

    it('creates event and seats atomically — a bad seat map creates neither', async () => {
      // rows exceeds the schema cap, so nothing should be written.
      await request(app.getHttpServer())
        .post('/events')
        .send(validEvent({ seatMap: { rows: 2000, seatsPerRow: 2000 } }))
        .expect(400);
    });

    describe('validation returns 400 with field-level messages', () => {
      it('rejects a blank name', async () => {
        const response = await request(app.getHttpServer())
          .post('/events')
          .send(validEvent({ name: '' }))
          .expect(400);

        expect(response.body.message).toBe('Validation failed');
        expect(response.body.errors).toContainEqual({
          field: 'name',
          message: expect.stringContaining('required') as unknown as string,
        });
      });

      it('rejects sales closing after the event starts', async () => {
        const response = await request(app.getHttpServer())
          .post('/events')
          .send(validEvent({ salesCloseAt: '2027-06-02T00:00:00.000Z' }))
          .expect(400);

        expect(response.body.errors).toContainEqual({
          field: 'salesCloseAt',
          message: 'salesCloseAt must not be after startsAt',
        });
      });

      it('rejects a negative price', async () => {
        await request(app.getHttpServer())
          .post('/events')
          .send(validEvent({ priceMinor: -1 }))
          .expect(400);
      });

      it('reports every problem at once, not one per request', async () => {
        const response = await request(app.getHttpServer())
          .post('/events')
          .send(validEvent({ name: '', priceMinor: -1, currency: 'TOOLONG' }))
          .expect(400);

        const fields = (response.body.errors as { field: string }[]).map((e) => e.field);
        expect(fields).toEqual(expect.arrayContaining(['name', 'priceMinor', 'currency']));
      });
    });

    describe('idempotency', () => {
      it('replays the stored response for a repeated Idempotency-Key', async () => {
        const key = randomUUID();
        const payload = validEvent();

        const first = await request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(201);

        const second = await request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(201);

        // Same event id: the second request did NOT create a second event.
        expect(second.body).toEqual(first.body);
      });

      it('rejects the same key used with a different body', async () => {
        const key = randomUUID();

        await request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', key)
          .send(validEvent())
          .expect(201);

        await request(app.getHttpServer())
          .post('/events')
          .set('Idempotency-Key', key)
          .send(validEvent({ priceMinor: 9999 }))
          .expect(409);
      });
    });
  });

  describe('GET /events/:id', () => {
    it('returns the event with a seat overview', async () => {
      const created = await request(app.getHttpServer())
        .post('/events')
        .send(validEvent())
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/events/${created.body.id}`)
        .expect(200);

      expect(response.body).toMatchObject({
        id: created.body.id,
        onSale: expect.any(Boolean) as unknown as boolean,
        seats: { total: 30, available: 30, held: 0, sold: 0 },
      });
    });

    it('returns 404 for an unknown event', async () => {
      await request(app.getHttpServer()).get(`/events/${randomUUID()}`).expect(404);
    });

    it('returns 400 for an id that is not a UUID', async () => {
      await request(app.getHttpServer()).get('/events/not-a-uuid').expect(400);
    });
  });

  describe('GET /events/:id/seats', () => {
    let eventId: string;

    beforeAll(async () => {
      const created = await request(app.getHttpServer())
        .post('/events')
        .send(validEvent({ seatMap: { rows: 5, seatsPerRow: 10 } }))
        .expect(201);

      eventId = created.body.id;
    });

    it('returns available seats by default, paginated', async () => {
      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats`)
        .expect(200);

      expect(response.body.pagination).toEqual({ total: 50, limit: 100, offset: 0 });
      expect(response.body.seats).toHaveLength(50);
    });

    it('honours limit and offset', async () => {
      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats?limit=10&offset=40`)
        .expect(200);

      expect(response.body.seats).toHaveLength(10);
      expect(response.body.pagination).toEqual({ total: 50, limit: 10, offset: 40 });
    });

    it('returns an empty page for SOLD when nothing is sold', async () => {
      const response = await request(app.getHttpServer())
        .get(`/events/${eventId}/seats?status=SOLD`)
        .expect(200);

      expect(response.body.seats).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('rejects an unknown status', async () => {
      await request(app.getHttpServer()).get(`/events/${eventId}/seats?status=WAT`).expect(400);
    });

    it('rejects a limit above the cap', async () => {
      await request(app.getHttpServer()).get(`/events/${eventId}/seats?limit=99999`).expect(400);
    });

    it('returns 404 for an unknown event rather than an empty page', async () => {
      await request(app.getHttpServer()).get(`/events/${randomUUID()}/seats`).expect(404);
    });
  });
});
