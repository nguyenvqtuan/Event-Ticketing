import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';

/**
 * TICK-11: idempotent payments, against a real Postgres.
 *
 * The property under test is not "the endpoint works" but "a retry cannot
 * charge twice, and gets the original answer". Both halves matter: returning a
 * fresh 409 to a retrying client is also wrong, because the client cannot tell
 * that from a genuine failure.
 */
describe('Payment idempotency (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;

  const SEAT_PRICE = 5000;

  async function heldReservation(seatCount = 2) {
    const event = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Pay ${randomUUID()}`,
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: 1, seatsPerRow: seatCount },
        priceMinor: SEAT_PRICE,
        currency: 'GBP',
      })
      .expect(201);

    const seats = await request(app.getHttpServer())
      .get(`/events/${event.body.id}/seats?limit=10`)
      .expect(200);

    const seatIds = (seats.body.seats as { id: string }[]).map((s) => s.id);

    const held = await request(app.getHttpServer())
      .post('/reservations')
      .send({ eventId: event.body.id, holderId: randomUUID(), seatIds })
      .expect(201);

    return {
      reservationId: held.body.id as string,
      total: SEAT_PRICE * seatIds.length,
    };
  }

  const pay = (id: string, key: string | null, amountMinor: number, currency = 'GBP') => {
    const req = request(app.getHttpServer()).post(`/reservations/${id}/pay`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ amountMinor, currency });
  };

  const stateOf = async (id: string): Promise<string> => {
    const r = await db.rootDb.execute<{ state: string }>(
      `SELECT state FROM reservations WHERE id = '${id}'` as never,
    );
    return String(r.rows[0]?.state);
  };

  /** How many times the side effect actually landed. */
  const versionOf = async (id: string): Promise<number> => {
    const r = await db.rootDb.execute<{ version: number }>(
      `SELECT version FROM reservations WHERE id = '${id}'` as never,
    );
    return Number(r.rows[0]?.version);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = moduleRef.get(DatabaseContext);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the key is mandatory', () => {
    it('rejects a payment with no Idempotency-Key', async () => {
      const { reservationId, total } = await heldReservation();

      const response = await pay(reservationId, null, total).expect(400);

      expect(response.body.message).toMatch(/idempotency-key/i);
      // Nothing happened: the guard runs before the side effect.
      expect(await stateOf(reservationId)).toBe('PENDING');
    });
  });

  describe('first call', () => {
    it('pays and confirms the reservation', async () => {
      const { reservationId, total } = await heldReservation();

      const response = await pay(reservationId, randomUUID(), total).expect(200);

      expect(response.body).toMatchObject({
        reservationId,
        state: 'CONFIRMED',
        paid: { amountMinor: total, currency: 'GBP' },
      });
      expect(await stateOf(reservationId)).toBe('CONFIRMED');
    });

    it('rejects an amount that does not match the seats', async () => {
      const { reservationId, total } = await heldReservation();

      await pay(reservationId, randomUUID(), total - 1).expect(422);

      // The mismatch is checked before confirming, so nothing was changed.
      expect(await stateOf(reservationId)).toBe('PENDING');
    });
  });

  describe('replay — same key, same payload', () => {
    it('returns the stored response verbatim and does not re-run the side effect', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      const first = await pay(reservationId, key, total).expect(200);
      const versionAfterFirst = await versionOf(reservationId);

      const second = await pay(reservationId, key, total).expect(200);

      expect(second.body).toEqual(first.body);
      // The decisive assertion: the state change happened exactly once.
      expect(await versionOf(reservationId)).toBe(versionAfterFirst);
    });

    it('replays even though a second real payment would have been rejected', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      await pay(reservationId, key, total).expect(200);

      // Without idempotency this would be 409 — the hold is already CONFIRMED
      // and cannot be confirmed twice. The replay hides that correctly.
      const replay = await pay(reservationId, key, total).expect(200);

      expect(replay.body.state).toBe('CONFIRMED');
    });
  });

  describe('misuse — same key, different payload', () => {
    it('is rejected without processing', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      await pay(reservationId, key, total).expect(200);
      const versionAfterFirst = await versionOf(reservationId);

      const reused = await pay(reservationId, key, total + 100).expect(409);

      expect(reused.body.message).toMatch(/different request body/i);
      expect(await versionOf(reservationId)).toBe(versionAfterFirst);
    });

    it('detects a key reused across different reservations', async () => {
      const a = await heldReservation();
      const b = await heldReservation();
      const key = randomUUID();

      await pay(a.reservationId, key, a.total).expect(200);
      await pay(b.reservationId, key, b.total).expect(409);

      expect(await stateOf(b.reservationId)).toBe('PENDING');
    });
  });

  describe('CONCURRENCY — two requests, one key', () => {
    it('runs the side effect ONCE and gives both callers the same response', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      // The DoD's scenario: a client retries before the first response lands.
      const [a, b] = await Promise.all([
        pay(reservationId, key, total),
        pay(reservationId, key, total),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body).toEqual(b.body);

      // Exactly one side effect: one version bump, not two.
      expect(await versionOf(reservationId)).toBe(1);
      expect(await stateOf(reservationId)).toBe('CONFIRMED');
    });

    it('holds under a wider burst', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 6 }, () => pay(reservationId, key, total)),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);

      // Compared structurally, not by JSON.stringify: the response is stored
      // as jsonb, which does not preserve key order, so a replayed body is
      // deeply equal to the original but may serialise with keys in a
      // different order. Clients must not depend on that order either.
      for (const result of results) {
        expect(result.body).toEqual(results[0]!.body);
      }

      expect(await versionOf(reservationId)).toBe(1);
    });

    it('stores exactly one key row', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      await Promise.all([pay(reservationId, key, total), pay(reservationId, key, total)]);

      const rows = await db.rootDb.execute<{ n: number }>(
        `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = '${key}'` as never,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });
  });

  describe('failed side effect', () => {
    it('does not persist a key when the payment fails, so a retry can succeed', async () => {
      const { reservationId, total } = await heldReservation();
      const key = randomUUID();

      // Wrong amount → 422, and the transaction rolls back with the key row.
      await pay(reservationId, key, total - 1).expect(422);

      const rows = await db.rootDb.execute<{ n: number }>(
        `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = '${key}'` as never,
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);

      // The same key is therefore reusable for the corrected request.
      await pay(reservationId, key, total).expect(200);
    });
  });
});
