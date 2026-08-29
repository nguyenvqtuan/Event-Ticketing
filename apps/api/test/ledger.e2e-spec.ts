import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
} from '../src/payment/domain/payment-repository.port.js';

/**
 * TICK-12: double-entry ledger and order confirmation, against real Postgres.
 */
describe('Ledger & order confirmation (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;

  const SEAT_PRICE = 5000;

  async function heldReservation(seatCount = 2, currency = 'GBP') {
    const event = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Ledger ${randomUUID()}`,
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: 1, seatsPerRow: seatCount },
        priceMinor: SEAT_PRICE,
        currency,
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
      eventId: event.body.id as string,
      reservationId: held.body.id as string,
      seatIds,
      total: SEAT_PRICE * seatIds.length,
    };
  }

  const pay = (id: string, amountMinor: number, currency = 'GBP') =>
    request(app.getHttpServer())
      .post(`/reservations/${id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor, currency });

  /**
   * Runs SQL expected to fail, returning the DATABASE's message.
   *
   * Drizzle wraps driver errors as "Failed query: ..." and puts the real one
   * on `cause`, so asserting on the outer message tests nothing about the
   * constraint. Same trap as the interceptor bug in TICK-11.
   */
  const expectDbError = async (sqlText: string): Promise<string> => {
    try {
      await db.rootDb.execute(sqlText as never);
      throw new Error(`Expected the database to reject: ${sqlText}`);
    } catch (error) {
      let current: unknown = error;
      const messages: string[] = [];
      for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
        messages.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      return messages.join(' | ');
    }
  };

  const one = async <T extends Record<string, unknown>>(
    sqlText: string,
  ): Promise<T | undefined> => {
    const r = await db.rootDb.execute<T>(sqlText as never);
    return r.rows[0] as T | undefined;
  };

  // A clean database per suite: worker databases are reused across the
  // suites a worker runs, and one suite's rows are another's noise.
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = moduleRef.get(DatabaseContext);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a successful payment is atomic', () => {
    it('writes seats SOLD, a PAID order, and balanced ledger entries together', async () => {
      const { reservationId, seatIds, total } = await heldReservation();

      const response = await pay(reservationId, total).expect(200);

      // Order
      const order = await one<{ state: string; total_minor: number }>(
        `SELECT state, total_minor FROM orders WHERE reservation_id = '${reservationId}'`,
      );
      expect(order?.state).toBe('PAID');
      expect(Number(order?.total_minor)).toBe(total);

      // Order lines froze the price at sale time
      const lines = await one<{ n: number; sum: number }>(
        `SELECT count(*)::int AS n, COALESCE(SUM(price_minor),0)::int AS sum
           FROM order_lines WHERE order_id = '${response.body.orderId}'`,
      );
      expect(Number(lines?.n)).toBe(seatIds.length);
      expect(Number(lines?.sum)).toBe(total);

      // Seats SOLD
      const sold = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM reservation_items
          WHERE reservation_id = '${reservationId}' AND claim_state = 'SOLD'`,
      );
      expect(Number(sold?.n)).toBe(seatIds.length);

      // Ledger: one transaction, two balanced entries
      const ledger = await one<{ entries: number; imbalance: number }>(
        `SELECT count(*)::int AS entries,
                COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_minor
                                  ELSE -amount_minor END),0)::int AS imbalance
           FROM ledger_entries
          WHERE transaction_id = (SELECT id FROM ledger_transactions
                                   WHERE reference = 'order:${response.body.orderId}:sale')`,
      );
      expect(Number(ledger?.entries)).toBe(2);
      expect(Number(ledger?.imbalance)).toBe(0);
    });

    it('sells the seat permanently — it cannot be held again', async () => {
      const { reservationId, eventId, seatIds, total } = await heldReservation(1);

      await pay(reservationId, total).expect(200);

      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds })
        .expect(409);
    });

    it('reports the seat as SOLD in the event overview', async () => {
      const { reservationId, eventId, total } = await heldReservation(2);

      await pay(reservationId, total).expect(200);

      const overview = await request(app.getHttpServer()).get(`/events/${eventId}`).expect(200);

      expect(overview.body.seats).toMatchObject({ total: 2, sold: 2, held: 0, available: 0 });
    });
  });

  describe('the ledger balances', () => {
    it.each([
      ['one seat', 1],
      ['three seats', 3],
      ['ten seats', 10],
    ])('for a payment of %s', async (_label, seatCount) => {
      const { reservationId, total } = await heldReservation(seatCount);

      const response = await pay(reservationId, total).expect(200);

      const row = await one<{ debits: number; credits: number }>(
        `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'),0)::int  AS debits,
                COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'),0)::int AS credits
           FROM ledger_entries
          WHERE transaction_id = (SELECT id FROM ledger_transactions
                                   WHERE reference = 'order:${response.body.orderId}:sale')`,
      );

      expect(Number(row?.debits)).toBe(total);
      expect(Number(row?.credits)).toBe(total);
    });

    it('holds across EVERY transaction in the database', async () => {
      // The invariant is global, not per-test: no transaction anywhere may be
      // unbalanced, whatever wrote it.
      const rows = await db.rootDb.execute<{ transaction_id: string; imbalance: number }>(
        `SELECT transaction_id,
                SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END)::int
                  AS imbalance
           FROM ledger_entries
          GROUP BY transaction_id
         HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0` as never,
      );

      expect(rows.rows).toEqual([]);
    });

    it('refuses an unbalanced transaction at COMMIT', async () => {
      const account = await one<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE name='cash' AND currency='GBP'`,
      );
      const txn = randomUUID();

      const message = await expectDbError(
        `BEGIN;
         INSERT INTO ledger_transactions (id, reference, currency)
           VALUES ('${txn}', 'bad', 'GBP');
         INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
           VALUES ('${txn}', '${account!.id}', 'DEBIT', 100, 'GBP');
         COMMIT;`,
      );

      expect(message).toMatch(/unbalanced/i);
    });
  });

  describe('the ledger is append-only', () => {
    it('refuses an UPDATE of a recorded entry', async () => {
      const { reservationId, total } = await heldReservation(1);
      await pay(reservationId, total).expect(200);

      const message = await expectDbError(
        `UPDATE ledger_entries SET amount_minor = 1 WHERE amount_minor = ${total}`,
      );

      expect(message).toMatch(/append-only/i);
    });

    it('refuses a DELETE of a recorded entry', async () => {
      const { reservationId, total } = await heldReservation(1);
      const response = await pay(reservationId, total).expect(200);

      const message = await expectDbError(
        `DELETE FROM ledger_entries WHERE transaction_id =
           (SELECT id FROM ledger_transactions WHERE reference='order:${response.body.orderId}:sale')`,
      );

      expect(message).toMatch(/append-only/i);
    });
  });

  describe('a reservation that cannot be paid', () => {
    it('rejects an already-paid reservation', async () => {
      const { reservationId, total } = await heldReservation(1);

      await pay(reservationId, total).expect(200);
      // Different key, so this is a genuine second attempt, not a replay.
      await pay(reservationId, total).expect(409);
    });

    it('rejects an expired reservation', async () => {
      const { reservationId, total } = await heldReservation(1);

      await db.rootDb.execute(
        `UPDATE reservations SET created_at = now() - interval '20 min',
                                 expires_at = now() - interval '1 min'
          WHERE id = '${reservationId}'` as never,
      );

      await pay(reservationId, total).expect(409);
    });

    it('rejects an amount that does not match the order total', async () => {
      const { reservationId, total } = await heldReservation(2);

      await pay(reservationId, total - 1).expect(422);
    });
  });

  describe('ATOMICITY — failure at the ledger-write step', () => {
    it('rolls everything back: no order, no SOLD seat, hold still PENDING', async () => {
      const { reservationId, eventId, seatIds, total } = await heldReservation(1);

      // A separate app whose ledger repository fails at exactly the last step,
      // after the seats and order have already been written in this
      // transaction. Nothing may survive.
      const failing = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(LEDGER_REPOSITORY)
        .useValue({
          accountId: () => Promise.resolve(randomUUID()),
          post: () => Promise.reject(new Error('ledger unavailable')),
        } satisfies LedgerRepository)
        .compile();

      const brokenApp = failing.createNestApplication();
      await brokenApp.init();

      try {
        await request(brokenApp.getHttpServer())
          .post(`/reservations/${reservationId}/pay`)
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: total, currency: 'GBP' })
          .expect(500);
      } finally {
        await brokenApp.close();
      }

      // No order was left behind.
      const order = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE reservation_id = '${reservationId}'`,
      );
      expect(Number(order?.n)).toBe(0);

      // No seat was left dangling as SOLD.
      const sold = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM reservation_items
          WHERE reservation_id = '${reservationId}' AND claim_state = 'SOLD'`,
      );
      expect(Number(sold?.n)).toBe(0);

      // The hold is untouched, so the customer can retry.
      const reservation = await one<{ state: string }>(
        `SELECT state FROM reservations WHERE id = '${reservationId}'`,
      );
      expect(reservation?.state).toBe('PENDING');

      // And the seat is still theirs, not released to someone else.
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds })
        .expect(409);

      // The retry, against the healthy app, succeeds.
      await pay(reservationId, total).expect(200);
    });
  });
});
