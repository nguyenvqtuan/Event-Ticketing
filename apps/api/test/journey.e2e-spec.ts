import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';
import { resetDatabase } from './support/database.js';

/**
 * TICK-17: the one journey that has to work — create event → hold seats → pay
 * → replay the payment → refund — over real HTTP against a listening server,
 * with a Testcontainers Postgres underneath (test/support/global-setup.ts).
 *
 * Deliberately ONE scenario. Error branches are cheaper and clearer a layer
 * down: the unit suites own the decisions, the feature suites own the
 * constraint and concurrency behaviour, and this proves the pieces compose.
 *
 * The app is bootstrapped and told to `listen`, so requests cross a socket and
 * go through the real HTTP stack — not `getHttpServer()` in memory as the
 * feature suites use. Port 0: the OS picks a free one, so parallel workers
 * cannot collide.
 *
 * Each step depends on the one before, so they run in order and share state.
 * That is the point of a journey test; anything needing isolation belongs in a
 * feature suite.
 */
describe('Buying a ticket, end to end (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;
  let baseUrl: string;

  const SEATS_PER_ROW = 5;
  const ROWS = 2;
  const TOTAL_SEATS = ROWS * SEATS_PER_ROW;
  const PRICE_MINOR = 5_000;
  const GBP = 'GBP';

  /** What the journey accumulates as it goes. */
  let eventId: string;
  let seatIds: string[];
  let reservationId: string;
  let orderId: string;

  /** Reused for the payment and its replay — the same key must mean the same charge. */
  const paymentKey = randomUUID();

  const api = () => request(baseUrl);

  const overview = async () => {
    const response = await api().get(`/events/${eventId}`).expect(200);

    return response.body.seats as { total: number; available: number; held: number; sold: number };
  };

  beforeAll(async () => {
    await resetDatabase();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    db = moduleRef.get(DatabaseContext);

    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    // Closes the server and runs Nest's shutdown hooks, which end the
    // connection pools. Without it the worker would hang onto a live socket.
    await app.close();
  });

  it('1. creates an event and its seat inventory in one request', async () => {
    const response = await api()
      .post('/events')
      .set('Idempotency-Key', randomUUID())
      .send({
        name: `Journey ${randomUUID()}`,
        // Open now, so the hold below is permitted.
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: ROWS, seatsPerRow: SEATS_PER_ROW },
        priceMinor: PRICE_MINOR,
        currency: GBP,
      })
      .expect(201);

    eventId = response.body.id as string;

    expect(response.body).toMatchObject({ seatsCreated: TOTAL_SEATS, totalSeats: TOTAL_SEATS });
    expect(await overview()).toEqual({
      total: TOTAL_SEATS,
      available: TOTAL_SEATS,
      held: 0,
      sold: 0,
    });
  });

  it('2. offers every seat as available', async () => {
    const response = await api()
      .get(`/events/${eventId}/seats?status=AVAILABLE&limit=100`)
      .expect(200);

    seatIds = (response.body.seats as { id: string }[]).map((seat) => seat.id);

    expect(seatIds).toHaveLength(TOTAL_SEATS);
  });

  it('3. holds two seats, which stop being available immediately', async () => {
    const response = await api()
      .post('/reservations')
      .send({ eventId, holderId: randomUUID(), seatIds: seatIds.slice(0, 2) })
      .expect(201);

    reservationId = response.body.id as string;

    expect(response.body.state).toBe('PENDING');
    expect(new Date(response.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    // Availability is derived from live claims, so the hold IS the change —
    // no separate "mark unavailable" step ran.
    expect(await overview()).toMatchObject({ available: TOTAL_SEATS - 2, held: 2, sold: 0 });
  });

  it('4. takes payment: the order is PAID and the seats are SOLD', async () => {
    const response = await api()
      .post(`/reservations/${reservationId}/pay`)
      .set('Idempotency-Key', paymentKey)
      .send({ amountMinor: 2 * PRICE_MINOR, currency: GBP })
      .expect(200);

    orderId = response.body.orderId as string;

    expect(response.body).toMatchObject({
      reservationId,
      state: 'PAID',
      paid: { amountMinor: 2 * PRICE_MINOR, currency: GBP },
    });
    expect(response.body.seatIds).toEqual(seatIds.slice(0, 2));
    expect(await overview()).toMatchObject({ available: TOTAL_SEATS - 2, held: 0, sold: 2 });
  });

  it('5. replays an identical payment without charging twice', async () => {
    const replay = await api()
      .post(`/reservations/${reservationId}/pay`)
      .set('Idempotency-Key', paymentKey)
      .send({ amountMinor: 2 * PRICE_MINOR, currency: GBP })
      .expect(200);

    // The stored response, not a second sale: same order, one set of entries.
    expect(replay.body.orderId).toBe(orderId);
    expect(await overview()).toMatchObject({ sold: 2 });
    expect(await ledgerEntryCount()).toBe(2);
  });

  it('6. refunds the order and returns the seats to sale', async () => {
    const response = await api()
      .post(`/orders/${orderId}/refund`)
      .set('Idempotency-Key', randomUUID())
      .send()
      .expect(200);

    expect(response.body).toMatchObject({
      orderId,
      state: 'REFUNDED',
      refunded: { amountMinor: 2 * PRICE_MINOR, currency: GBP },
    });
    // Back where the journey started: releasing the claims IS the release.
    expect(await overview()).toEqual({
      total: TOTAL_SEATS,
      available: TOTAL_SEATS,
      held: 0,
      sold: 0,
    });
  });

  it('7. leaves books that balance, with the sale still on the record', async () => {
    // The one assertion not made over HTTP: no endpoint exposes the ledger,
    // and "the money adds up" is what the whole journey is for.
    const rows = await db.rootDb.execute<{ net: number; entries: number }>(
      `SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END)::int AS net,
              count(*)::int AS entries
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.reference LIKE 'order:${orderId}:%'` as never,
    );

    // Two entries for the sale, two reversing them — the sale was never
    // edited or deleted, which is what makes the history auditable.
    expect(rows.rows[0]?.entries).toBe(4);
    expect(rows.rows[0]?.net).toBe(0);
  });

  /** Entries written for this order so far, however many transactions. */
  async function ledgerEntryCount(): Promise<number> {
    const rows = await db.rootDb.execute<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.reference LIKE 'order:${orderId}:%'` as never,
    );

    return Number(rows.rows[0]?.n ?? 0);
  }
});
