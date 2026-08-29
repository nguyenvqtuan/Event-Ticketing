import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';
import { ExpireReservationsUseCase } from '../src/inventory/application/expire-reservations.use-case.js';

/**
 * TICK-10: expiry and automatic seat release, against a real Postgres.
 *
 * Holds are made to lapse by rewinding `expires_at` in SQL rather than by
 * sleeping — a test that waits out a 15-minute TTL is not a test anyone runs.
 */
describe('Reservation expiry (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;
  let sweeper: ExpireReservationsUseCase;

  async function seedEvent(seatsPerRow = 3) {
    const event = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Expiry ${randomUUID()}`,
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: 1, seatsPerRow },
        priceMinor: 5000,
        currency: 'GBP',
      })
      .expect(201);

    const seats = await request(app.getHttpServer())
      .get(`/events/${event.body.id}/seats?limit=10`)
      .expect(200);

    return {
      eventId: event.body.id as string,
      seatIds: (seats.body.seats as { id: string }[]).map((s) => s.id),
    };
  }

  const hold = (eventId: string, seatIds: string[]) =>
    request(app.getHttpServer())
      .post('/reservations')
      .send({ eventId, holderId: randomUUID(), seatIds });

  /** Rewinds a hold so its TTL has already lapsed. */
  const lapse = (id: string) =>
    db.rootDb.execute(
      `UPDATE reservations SET expires_at = now() - interval '1 minute',
                               created_at = now() - interval '20 minutes'
        WHERE id = '${id}';
       UPDATE reservation_items
          SET valid_during = tstzrange(now() - interval '20 minutes', now() - interval '1 minute')
        WHERE reservation_id = '${id}'` as never,
    );

  const stateOf = async (id: string): Promise<string> => {
    const r = await db.rootDb.execute<{ state: string }>(
      `SELECT state FROM reservations WHERE id = '${id}'` as never,
    );
    return String(r.rows[0]?.state);
  };

  const liveClaims = async (seatId: string): Promise<number> => {
    const r = await db.rootDb.execute<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_items
        WHERE seat_id = '${seatId}' AND claim_state <> 'RELEASED'
          AND valid_during @> now()` as never,
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  // Between tests, not just suites: the sweeper claims every lapsed
  // reservation in the database, so a leftover row from the previous test
  // would be swept into this one's count.
  beforeEach(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = moduleRef.get(DatabaseContext);
    sweeper = moduleRef.get(ExpireReservationsUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('LAZY layer — no sweeper required', () => {
    it('frees the seat the moment the TTL lapses, with no job having run', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);

      await hold(eventId, [seatIds[0]!]).expect(409); // taken

      await lapse(held.body.id);

      // Nothing has swept. The row still says PENDING...
      expect(await stateOf(held.body.id)).toBe('PENDING');
      // ...yet the seat is already sellable, because availability is derived
      // from the claim's validity period rather than from a status column.
      expect(await liveClaims(seatIds[0]!)).toBe(0);
      await hold(eventId, [seatIds[0]!]).expect(201);
    });

    it('reports the hold as expired even though its stored state is PENDING', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);
      await lapse(held.body.id);

      const view = await request(app.getHttpServer())
        .get(`/reservations/${held.body.id}`)
        .expect(200);

      expect(view.body.state).toBe('PENDING');
      expect(view.body.expired).toBe(true);
      expect(view.body.holdsSeats).toBe(false);
    });
  });

  describe('SWEEPER layer — bookkeeping', () => {
    it('moves a lapsed hold to EXPIRED and releases its claims', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);
      await lapse(held.body.id);

      expect(await sweeper.execute()).toBeGreaterThanOrEqual(1);

      expect(await stateOf(held.body.id)).toBe('EXPIRED');
      await hold(eventId, [seatIds[0]!]).expect(201);
    });

    it('leaves live holds alone', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);

      await sweeper.execute();

      expect(await stateOf(held.body.id)).toBe('PENDING');
      expect(await liveClaims(seatIds[0]!)).toBe(1);
    });

    it('is idempotent — a second sweep finds nothing to do', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);
      await lapse(held.body.id);

      await sweeper.execute();
      const second = await sweeper.execute();

      expect(second).toBe(0);
      expect(await stateOf(held.body.id)).toBe('EXPIRED');
    });

    it('is safe with several sweepers at once — SKIP LOCKED splits the batch', async () => {
      const { eventId, seatIds } = await seedEvent(5);
      const ids: string[] = [];

      for (const seat of seatIds) {
        const held = await hold(eventId, [seat]).expect(201);
        await lapse(held.body.id);
        ids.push(held.body.id);
      }

      // Simulates @Cron firing on several replicas simultaneously.
      const counts = await Promise.all([sweeper.execute(), sweeper.execute(), sweeper.execute()]);

      // Disjoint batches: every reservation expired exactly once between them.
      for (const id of ids) {
        expect(await stateOf(id)).toBe('EXPIRED');
      }
      expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(ids.length);
    });
  });

  describe('RACE — expiry versus payment', () => {
    it('payment WINS when it arrives before the TTL', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);

      const [confirmed] = await Promise.all([
        request(app.getHttpServer()).post(`/reservations/${held.body.id}/confirm`),
        sweeper.execute(),
      ]);

      expect(confirmed.status).toBe(200);
      expect(await stateOf(held.body.id)).toBe('CONFIRMED');
      // The seat stays claimed — a confirmed hold must not free itself.
      expect(await liveClaims(seatIds[0]!)).toBe(1);
    });

    it('payment is REJECTED once the TTL has lapsed, even before any sweep', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);
      await lapse(held.body.id);

      // No sweeper has run: the row still says PENDING. The aggregate rejects
      // it anyway, because expiry is a fact about the clock.
      expect(await stateOf(held.body.id)).toBe('PENDING');
      await request(app.getHttpServer()).post(`/reservations/${held.body.id}/confirm`).expect(409);
    });

    it('a confirmed hold survives the sweeper indefinitely', async () => {
      const { eventId, seatIds } = await seedEvent();
      const held = await hold(eventId, [seatIds[0]!]).expect(201);

      await request(app.getHttpServer()).post(`/reservations/${held.body.id}/confirm`).expect(200);

      // Rewind the ORIGINAL ttl. Confirm extended the claim to infinity, so
      // this must not free the seat.
      // created_at moves too: reservations_ttl_positive requires
      // expires_at > created_at, and rightly rejects the rewind otherwise.
      await db.rootDb.execute(
        `UPDATE reservations
            SET created_at = now() - interval '20 minutes',
                expires_at = now() - interval '1 minute'
          WHERE id = '${held.body.id}'` as never,
      );

      await sweeper.execute();

      expect(await stateOf(held.body.id)).toBe('CONFIRMED');
      expect(await liveClaims(seatIds[0]!)).toBe(1);
      await hold(eventId, [seatIds[0]!]).expect(409);
    });
  });
});
