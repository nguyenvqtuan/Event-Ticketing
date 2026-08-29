import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { resetDatabase } from './support/database.js';

/**
 * Proves the constraints actually hold, against a real Postgres.
 *
 * The database is provisioned by test/support/global-setup.ts (Testcontainers,
 * migrated with the project's own runner), so there is nothing to skip around:
 * these tests either run or fail. They used to skip when no database was
 * reachable, and a skip is not a pass.
 */
let client: Client;

const HOUR = 60 * 60 * 1000;

async function seedEventWithSeat(): Promise<{ eventId: string; seatId: string }> {
  const startsAt = new Date(Date.now() + 30 * 24 * HOUR);

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO events (name, starts_at, sales_open_at, sales_close_at)
     VALUES ('Test Event', $1, now(), $1) RETURNING id`,
    [startsAt],
  );
  const eventId = eventRows[0]!.id;

  const { rows: seatRows } = await client.query<{ id: string }>(
    `INSERT INTO seats (event_id, code, price_minor, currency)
     VALUES ($1, $2, 5000, 'GBP') RETURNING id`,
    [eventId, `A${Math.floor(Math.random() * 1e9)}`],
  );

  return { eventId, seatId: seatRows[0]!.id };
}

async function openReservation(eventId: string, expiresAt: Date): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO reservations (event_id, holder_id, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [eventId, randomUUID(), expiresAt],
  );

  return rows[0]!.id;
}

const claim = (reservationId: string, seatId: string, range: string, state = 'HELD') =>
  client.query(
    `INSERT INTO reservation_items (reservation_id, seat_id, claim_state, valid_during)
     VALUES ($1, $2, $3, $4::tstzrange)`,
    [reservationId, seatId, state, range],
  );

beforeAll(async () => {
  await resetDatabase();

  client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end().catch(() => undefined);
});

describe('Schema constraints (integration)', () => {
  describe('double-booking', () => {
    it('refuses a second live hold on the same seat', async () => {
      const { eventId, seatId } = await seedEventWithSeat();
      const expiresAt = new Date(Date.now() + HOUR);

      const first = await openReservation(eventId, expiresAt);
      await claim(first, seatId, `[${new Date().toISOString()},${expiresAt.toISOString()})`);

      const second = await openReservation(eventId, expiresAt);

      await expect(
        claim(second, seatId, `[${new Date().toISOString()},${expiresAt.toISOString()})`),
      ).rejects.toMatchObject({ code: '23P01' }); // exclusion_violation
    });

    it('ALLOWS a new hold once the previous one has expired — no sweeper needed', async () => {
      const { eventId, seatId } = await seedEventWithSeat();

      // A hold that already lapsed. Nothing has updated its row.
      const past = await openReservation(eventId, new Date(Date.now() + HOUR));
      const lapsedFrom = new Date(Date.now() - 2 * HOUR).toISOString();
      const lapsedTo = new Date(Date.now() - HOUR).toISOString();
      await claim(past, seatId, `[${lapsedFrom},${lapsedTo})`);

      const next = await openReservation(eventId, new Date(Date.now() + HOUR));

      await expect(
        claim(
          next,
          seatId,
          `[${new Date().toISOString()},${new Date(Date.now() + HOUR).toISOString()})`,
        ),
      ).resolves.toBeDefined();
    });

    it('refuses any later hold once a seat is SOLD', async () => {
      const { eventId, seatId } = await seedEventWithSeat();

      const sold = await openReservation(eventId, new Date(Date.now() + HOUR));
      await claim(sold, seatId, `[${new Date().toISOString()},infinity)`, 'SOLD');

      const later = await openReservation(eventId, new Date(Date.now() + 10 * HOUR));
      const from = new Date(Date.now() + 5 * HOUR).toISOString();
      const to = new Date(Date.now() + 6 * HOUR).toISOString();

      await expect(claim(later, seatId, `[${from},${to})`)).rejects.toMatchObject({
        code: '23P01',
      });
    });

    it('frees the seat immediately when a claim is RELEASED', async () => {
      const { eventId, seatId } = await seedEventWithSeat();
      const expiresAt = new Date(Date.now() + HOUR);
      const range = `[${new Date().toISOString()},${expiresAt.toISOString()})`;

      const first = await openReservation(eventId, expiresAt);
      await claim(first, seatId, range);
      await client.query(
        `UPDATE reservation_items SET claim_state = 'RELEASED' WHERE reservation_id = $1`,
        [first],
      );

      const second = await openReservation(eventId, expiresAt);

      await expect(claim(second, seatId, range)).resolves.toBeDefined();
    });
  });

  describe('double-entry ledger', () => {
    it('accepts a balanced transaction', async () => {
      const { rows: acct } = await client.query<{ id: string }>(
        `INSERT INTO ledger_accounts (name, type, currency)
         VALUES ($1,'ASSET','GBP'), ($2,'REVENUE','GBP') RETURNING id`,
        [`cash-${randomUUID()}`, `revenue-${randomUUID()}`],
      );
      const { rows: txn } = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (reference, currency) VALUES ('ord-1','GBP') RETURNING id`,
      );

      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
         VALUES ($1,$2,'DEBIT',5000,'GBP'), ($1,$3,'CREDIT',5000,'GBP')`,
        [txn[0]!.id, acct[0]!.id, acct[1]!.id],
      );

      await expect(client.query('COMMIT')).resolves.toBeDefined();
    });

    it('REJECTS an unbalanced transaction at COMMIT, not before', async () => {
      const { rows: acct } = await client.query<{ id: string }>(
        `INSERT INTO ledger_accounts (name, type, currency)
         VALUES ($1,'ASSET','GBP'), ($2,'REVENUE','GBP') RETURNING id`,
        [`cash-${randomUUID()}`, `revenue-${randomUUID()}`],
      );
      const { rows: txn } = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (reference, currency) VALUES ('ord-2','GBP') RETURNING id`,
      );

      await client.query('BEGIN');
      // Deferred: this single-sided insert succeeds...
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
         VALUES ($1,$2,'DEBIT',5000,'GBP'), ($1,$3,'CREDIT',4999,'GBP')`,
        [txn[0]!.id, acct[0]!.id, acct[1]!.id],
      );

      // ...and the imbalance is caught only when the transaction commits.
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/i);
      await client.query('ROLLBACK').catch(() => undefined);
    });
  });

  describe('domain invariants mirrored in SQL', () => {
    it('rejects an event whose sales close after it starts', async () => {
      const startsAt = new Date(Date.now() + 30 * 24 * HOUR);
      const closesAfter = new Date(startsAt.getTime() + HOUR);

      await expect(
        client.query(
          `INSERT INTO events (name, starts_at, sales_open_at, sales_close_at)
           VALUES ('Bad', $1, now(), $2)`,
          [startsAt, closesAfter],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation
    });

    it('rejects a duplicate seat code within one event', async () => {
      const { eventId } = await seedEventWithSeat();

      await client.query(
        `INSERT INTO seats (event_id, code, price_minor, currency) VALUES ($1,'DUP',100,'GBP')`,
        [eventId],
      );

      await expect(
        client.query(
          `INSERT INTO seats (event_id, code, price_minor, currency) VALUES ($1,'DUP',100,'GBP')`,
          [eventId],
        ),
      ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    });

    it('rejects a FAILED order with no reason', async () => {
      const { eventId } = await seedEventWithSeat();
      const reservationId = await openReservation(eventId, new Date(Date.now() + HOUR));

      await expect(
        client.query(
          `INSERT INTO orders (reservation_id, state, total_minor, currency)
           VALUES ($1,'FAILED',100,'GBP')`,
          [reservationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
