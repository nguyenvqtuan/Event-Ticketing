import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';

/**
 * TICK-8's mandatory concurrency tests, against a real Postgres — provisioned
 * and migrated by test/support/global-setup.ts.
 *
 * These race real HTTP requests through real transactions. Mocks cannot show
 * what is being asserted here: that Postgres, not application code, is what
 * makes double-booking impossible.
 */
describe('Reservations — holds and concurrency (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;

  /** Creates an event that is on sale now, and returns its seat ids. */
  async function seedEvent(rows = 2, seatsPerRow = 5) {
    const created = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Race ${randomUUID()}`,
        // Open now, so holds are permitted.
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows, seatsPerRow },
        priceMinor: 5000,
        currency: 'GBP',
      })
      .expect(201);

    const seats = await request(app.getHttpServer())
      .get(`/events/${created.body.id}/seats?limit=500`)
      .expect(200);

    return {
      eventId: created.body.id as string,
      seatIds: (seats.body.seats as { id: string }[]).map((s) => s.id),
    };
  }

  const hold = (eventId: string, seatIds: string[]) =>
    request(app.getHttpServer())
      .post('/reservations')
      .send({ eventId, holderId: randomUUID(), seatIds });

  /** Counts live claims on a seat straight from the database. */
  async function liveClaims(seatId: string): Promise<number> {
    const result = await db.rootDb.execute<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_items
       WHERE seat_id = '${seatId}'
         AND claim_state <> 'RELEASED'
         AND valid_during @> now()` as never,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  // A clean database per suite: worker databases are reused across the
  // suites a worker runs, and one suite's rows are another's noise.
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Listening for the suite's lifetime because this suite races concurrent
    // requests: supertest closes a server it had to start itself as soon as the
    // FIRST request finishes, resetting the ones still in flight (docs/testing.md).
    await app.listen(0);
    db = moduleRef.get(DatabaseContext);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /reservations', () => {
    it('holds seats and returns expiresAt', async () => {
      const { eventId, seatIds } = await seedEvent();

      const response = await hold(eventId, seatIds.slice(0, 2)).expect(201);

      expect(response.body).toMatchObject({
        eventId,
        seatIds: seatIds.slice(0, 2),
        state: 'PENDING',
      });
      expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('applies the configured TTL', async () => {
      const { eventId, seatIds } = await seedEvent();

      const response = await hold(eventId, [seatIds[0]!]).expect(201);

      const ttlMs =
        new Date(response.body.expiresAt).getTime() - new Date(response.body.createdAt).getTime();

      // RESERVATION_TTL_SECONDS defaults to 900 (TICK-2).
      expect(ttlMs).toBe(900 * 1000);
    });

    it('refuses to hold a seat that is already held', async () => {
      const { eventId, seatIds } = await seedEvent();
      await hold(eventId, [seatIds[0]!]).expect(201);

      const response = await hold(eventId, [seatIds[0]!]).expect(409);

      expect(response.body.unavailableSeatIds).toEqual([seatIds[0]]);
    });

    it('rejects seats belonging to another event', async () => {
      const a = await seedEvent();
      const b = await seedEvent();

      const response = await hold(a.eventId, [b.seatIds[0]!]).expect(409);

      expect(response.body.missingSeatIds).toEqual([b.seatIds[0]]);
    });

    it('rejects a hold when sales are closed', async () => {
      const created = await request(app.getHttpServer())
        .post('/events')
        .send({
          name: `Closed ${randomUUID()}`,
          salesOpenAt: new Date(Date.now() + 86_400_000).toISOString(),
          salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          seatMap: { rows: 1, seatsPerRow: 2 },
          priceMinor: 5000,
          currency: 'GBP',
        })
        .expect(201);

      const seats = await request(app.getHttpServer())
        .get(`/events/${created.body.id}/seats`)
        .expect(200);

      await hold(created.body.id, [seats.body.seats[0].id]).expect(409);
    });

    describe('validation', () => {
      it('rejects an empty seat list', async () => {
        const { eventId } = await seedEvent();
        await hold(eventId, []).expect(400);
      });

      it('rejects duplicate seat ids', async () => {
        const { eventId, seatIds } = await seedEvent();
        await hold(eventId, [seatIds[0]!, seatIds[0]!]).expect(400);
      });
    });
  });

  describe('all-or-nothing', () => {
    it('holds NOTHING when one of several seats is already taken', async () => {
      const { eventId, seatIds } = await seedEvent(2, 5);
      const [first, second, third] = seatIds;

      // Someone already holds the middle seat.
      await hold(eventId, [second!]).expect(201);

      const response = await hold(eventId, [first!, second!, third!]).expect(409);

      expect(response.body.unavailableSeatIds).toEqual([second]);

      // The two that WERE free must remain free — no partial hold.
      expect(await liveClaims(first!)).toBe(0);
      expect(await liveClaims(third!)).toBe(0);
      expect(await liveClaims(second!)).toBe(1);
    });
  });

  describe('CONCURRENCY — N requests racing for the same seat', () => {
    it.each([5, 20])('exactly one of %i concurrent holds succeeds', async (n) => {
      const { eventId, seatIds } = await seedEvent();
      const contested = seatIds[0]!;

      const results = await Promise.all(
        Array.from({ length: n }, () => hold(eventId, [contested])),
      );

      const created = results.filter((r) => r.status === 201);
      const conflicted = results.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(conflicted).toHaveLength(n - 1);
      // No request may fail for any other reason — a 500 here would mean the
      // race produced an unhandled error rather than a clean conflict.
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);

      // The database is the real assertion: one live claim, not N.
      expect(await liveClaims(contested)).toBe(1);
    });

    it('multi-seat holds racing in opposite orders do not deadlock', async () => {
      const { eventId, seatIds } = await seedEvent(2, 5);
      const [a, b, c, d] = seatIds;

      // Overlapping sets given in different orders. Without a deterministic
      // lock order these would deadlock; the repository sorts by seat id.
      const results = await Promise.all([
        hold(eventId, [a!, b!, c!]),
        hold(eventId, [c!, b!, a!]),
        hold(eventId, [b!, d!, a!]),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);

      // Every contested seat ends with at most one live claim.
      for (const seat of [a!, b!, c!]) {
        expect(await liveClaims(seat)).toBeLessThanOrEqual(1);
      }
    });

    it('lets a different seat be held concurrently — locks are per row', async () => {
      const { eventId, seatIds } = await seedEvent(2, 5);

      const results = await Promise.all(seatIds.slice(0, 5).map((seat) => hold(eventId, [seat])));

      // Disjoint seats: no contention, so all five succeed.
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    });
  });

  describe('GET /reservations/:id', () => {
    it('returns the hold with its computed expiry state', async () => {
      const { eventId, seatIds } = await seedEvent();
      const created = await hold(eventId, [seatIds[0]!]).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/reservations/${created.body.id}`)
        .expect(200);

      expect(response.body).toMatchObject({
        state: 'PENDING',
        expired: false,
        holdsSeats: true,
      });
    });

    it('returns 404 for an unknown reservation', async () => {
      await request(app.getHttpServer()).get(`/reservations/${randomUUID()}`).expect(404);
    });
  });
});
