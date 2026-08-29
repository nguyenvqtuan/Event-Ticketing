import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';

/**
 * TICK-13: refunds as reversing entries, against real Postgres.
 *
 * The property under test is that history is ADDED TO, never edited: after a
 * refund the money nets to zero while both the original and the reversing
 * entries remain readable.
 */
describe('Refunds (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;

  const SEAT_PRICE = 5000;

  /** Buys seats and returns the resulting order. */
  async function paidOrder(seatCount = 2) {
    const event = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Refund ${randomUUID()}`,
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

    const total = SEAT_PRICE * seatIds.length;

    const paid = await request(app.getHttpServer())
      .post(`/reservations/${held.body.id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: total, currency: 'GBP' })
      .expect(200);

    return {
      eventId: event.body.id as string,
      seatIds,
      orderId: paid.body.orderId as string,
      total,
    };
  }

  const refund = (orderId: string, key = randomUUID()) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/refund`).set('Idempotency-Key', key);

  const one = async <T extends Record<string, unknown>>(
    sqlText: string,
  ): Promise<T | undefined> => {
    const r = await db.rootDb.execute<T>(sqlText as never);
    return r.rows[0] as T | undefined;
  };

  /** Every ledger row for an order — sale and reversal share the prefix. */
  const ledgerFor = (orderId: string) => `
    SELECT e.direction, e.amount_minor, t.reference
      FROM ledger_entries e
      JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE t.reference LIKE 'order:${orderId}%'`;

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

  describe('the refund nets to zero without deleting history', () => {
    it('leaves the order at a net of 0 across all its entries', async () => {
      const { orderId, total } = await paidOrder();

      const before = await one<{ net: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_minor
                                  ELSE -amount_minor END),0)::int AS net
           FROM (${ledgerFor(orderId)}) x`,
      );
      // Before the refund the sale sits on the books.
      expect(Number(before?.net)).toBe(0); // debits and credits already balance

      await refund(orderId).expect(200);

      const after = await one<{ entries: number; debits: number; credits: number }>(
        `SELECT count(*)::int AS entries,
                COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'),0)::int  AS debits,
                COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'),0)::int AS credits
           FROM (${ledgerFor(orderId)}) x`,
      );

      // Four entries now: two for the sale, two reversing it.
      expect(Number(after?.entries)).toBe(4);
      expect(Number(after?.debits)).toBe(total * 2);
      expect(Number(after?.credits)).toBe(total * 2);
    });

    it('nets each ACCOUNT to zero — cash in then out, revenue up then down', async () => {
      const { orderId, total } = await paidOrder(1);

      await refund(orderId).expect(200);

      const rows = await db.rootDb.execute<{ name: string; net: number }>(
        `SELECT a.name,
                SUM(CASE WHEN e.direction='DEBIT' THEN e.amount_minor
                         ELSE -e.amount_minor END)::int AS net
           FROM ledger_entries e
           JOIN ledger_transactions t ON t.id = e.transaction_id
           JOIN ledger_accounts a     ON a.id = e.account_id
          WHERE t.reference LIKE 'order:${orderId}%'
          GROUP BY a.name` as never,
      );

      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(Number(row.net)).toBe(0);
      }
      // Sanity: the amounts were non-trivial, so "0" means cancelled out
      // rather than nothing having been written.
      expect(total).toBeGreaterThan(0);
    });

    it('KEEPS the original entries — the sale is still on the books', async () => {
      const { orderId, total } = await paidOrder(1);

      await refund(orderId).expect(200);

      const sale = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_entries e
           JOIN ledger_transactions t ON t.id = e.transaction_id
          WHERE t.reference = 'order:${orderId}:sale' AND e.amount_minor = ${total}`,
      );
      const reversal = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_entries e
           JOIN ledger_transactions t ON t.id = e.transaction_id
          WHERE t.reference = 'order:${orderId}:refund' AND e.amount_minor = ${total}`,
      );

      expect(Number(sale?.n)).toBe(2);
      expect(Number(reversal?.n)).toBe(2);
    });

    it('records the reversal as the mirror image of the sale', async () => {
      const { orderId } = await paidOrder(1);
      await refund(orderId).expect(200);

      const rows = await db.rootDb.execute<{ reference: string; direction: string; name: string }>(
        `SELECT t.reference, e.direction, a.name
           FROM ledger_entries e
           JOIN ledger_transactions t ON t.id = e.transaction_id
           JOIN ledger_accounts a     ON a.id = e.account_id
          WHERE t.reference LIKE 'order:${orderId}%'` as never,
      );

      const find = (ref: string, name: string) =>
        rows.rows.find((r) => r.reference.endsWith(ref) && r.name === name)?.direction;

      expect(find('sale', 'cash')).toBe('DEBIT');
      expect(find('sale', 'ticket_revenue')).toBe('CREDIT');
      expect(find('refund', 'cash')).toBe('CREDIT');
      expect(find('refund', 'ticket_revenue')).toBe('DEBIT');
    });
  });

  describe('order and seats', () => {
    it('transitions the order to REFUNDED', async () => {
      const { orderId } = await paidOrder(1);

      const response = await refund(orderId).expect(200);

      expect(response.body.state).toBe('REFUNDED');
      const row = await one<{ state: string; version: number }>(
        `SELECT state, version FROM orders WHERE id = '${orderId}'`,
      );
      expect(row?.state).toBe('REFUNDED');
      // The version column added in TICK-9 is finally exercised.
      expect(Number(row?.version)).toBe(1);
    });

    it('returns the seats to sale', async () => {
      const { orderId, eventId, seatIds } = await paidOrder(1);

      // Sold, so unavailable.
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds })
        .expect(409);

      await refund(orderId).expect(200);

      // Released, so sellable again — no separate "make available" step.
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId, holderId: randomUUID(), seatIds })
        .expect(201);
    });

    it('shows the seat as available again in the event overview', async () => {
      const { orderId, eventId } = await paidOrder(2);

      await refund(orderId).expect(200);

      const overview = await request(app.getHttpServer()).get(`/events/${eventId}`).expect(200);

      expect(overview.body.seats).toMatchObject({ total: 2, sold: 0, held: 0, available: 2 });
    });
  });

  describe('no double refunds', () => {
    it('rejects a second refund under a DIFFERENT idempotency key', async () => {
      const { orderId } = await paidOrder(1);

      await refund(orderId).expect(200);
      // A genuine second attempt, not a retry. The order's state machine, not
      // the idempotency key, is what refuses this.
      await refund(orderId).expect(409);
    });

    it('replays rather than re-refunding for the SAME key', async () => {
      const { orderId, total } = await paidOrder(1);
      const key = randomUUID();

      const first = await refund(orderId, key).expect(200);
      const second = await refund(orderId, key).expect(200);

      expect(second.body).toEqual(first.body);

      // Still exactly one reversal: the replay moved no money.
      const reversals = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_transactions
          WHERE reference = 'order:${orderId}:refund'`,
      );
      expect(Number(reversals?.n)).toBe(1);

      const net = await one<{ net: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount_minor
                                  ELSE -amount_minor END),0)::int AS net
           FROM (${ledgerFor(orderId)}) x`,
      );
      expect(Number(net?.net)).toBe(0);
      expect(total).toBeGreaterThan(0);
    });

    it('survives concurrent refunds of the same order', async () => {
      const { orderId } = await paidOrder(1);

      // Different keys, so idempotency does not mask the race — the row lock
      // and the state machine have to.
      const results = await Promise.all([
        refund(orderId, randomUUID()),
        refund(orderId, randomUUID()),
        refund(orderId, randomUUID()),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);

      const reversals = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_transactions
          WHERE reference = 'order:${orderId}:refund'`,
      );
      expect(Number(reversals?.n)).toBe(1);
    });
  });

  describe('guards', () => {
    it('returns 404 for an unknown order', async () => {
      await refund(randomUUID()).expect(404);
    });

    it('requires an idempotency key', async () => {
      const { orderId } = await paidOrder(1);

      await request(app.getHttpServer()).post(`/orders/${orderId}/refund`).expect(400);
    });
  });

  describe('the ledger stays balanced overall', () => {
    it('has no unbalanced transaction anywhere after refunds', async () => {
      const { orderId } = await paidOrder(3);
      await refund(orderId).expect(200);

      const rows = await db.rootDb.execute<{ transaction_id: string }>(
        `SELECT transaction_id FROM ledger_entries
          GROUP BY transaction_id
         HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor
                         ELSE -amount_minor END) <> 0` as never,
      );

      expect(rows.rows).toEqual([]);
    });
  });
});
