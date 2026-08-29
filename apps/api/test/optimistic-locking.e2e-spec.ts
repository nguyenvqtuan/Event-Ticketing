import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { resetDatabase } from './support/database.js';
import { ConcurrentModification } from '../src/shared/domain/domain-error.js';
import { DatabaseContext } from '../src/shared/infrastructure/database/database.module.js';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../src/inventory/domain/reservation-repository.port.js';

/**
 * TICK-9's mandatory lost-update test, against a real Postgres.
 *
 * A lost update is invisible without this kind of test: both writers succeed,
 * both report success, and one change silently vanishes. The assertion is that
 * the second writer is REJECTED rather than quietly winning.
 */
describe('Optimistic locking (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseContext;
  let reservations: ReservationRepository;

  async function heldReservation(): Promise<string> {
    const event = await request(app.getHttpServer())
      .post('/events')
      .send({
        name: `Optimistic ${randomUUID()}`,
        salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
        salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        seatMap: { rows: 1, seatsPerRow: 3 },
        priceMinor: 5000,
        currency: 'GBP',
      })
      .expect(201);

    const seats = await request(app.getHttpServer())
      .get(`/events/${event.body.id}/seats?limit=3`)
      .expect(200);

    const held = await request(app.getHttpServer())
      .post('/reservations')
      .send({
        eventId: event.body.id,
        holderId: randomUUID(),
        seatIds: [seats.body.seats[0].id],
      })
      .expect(201);

    return held.body.id as string;
  }

  const versionOf = async (id: string): Promise<number> => {
    const result = await db.rootDb.execute<{ version: number }>(
      `SELECT version FROM reservations WHERE id = '${id}'` as never,
    );
    return Number(result.rows[0]?.version);
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
    reservations = moduleRef.get<ReservationRepository>(RESERVATION_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('version column', () => {
    it('starts at 0 for a new reservation', async () => {
      expect(await versionOf(await heldReservation())).toBe(0);
    });

    it('increments on each successful update', async () => {
      const id = await heldReservation();

      await request(app.getHttpServer()).post(`/reservations/${id}/cancel`).expect(200);

      expect(await versionOf(id)).toBe(1);
    });
  });

  describe('LOST UPDATE — two writers holding the same version', () => {
    it('rejects the second writer instead of overwriting the first', async () => {
      const id = await heldReservation();

      // Both load the aggregate at version 0 — the classic setup. Without the
      // version check both would write and one change would vanish.
      const [a, b] = await Promise.all([reservations.findById(id), reservations.findById(id)]);

      expect(a!.version).toBe(0);
      expect(b!.version).toBe(0);

      a!.cancel();
      b!.cancel();

      await reservations.updateState(a!);

      // Second writer still believes it is at version 0. It is not.
      await expect(reservations.updateState(b!)).rejects.toThrow(ConcurrentModification);

      // Exactly one increment: the losing write did not land.
      expect(await versionOf(id)).toBe(1);
    });

    it('rejects concurrent cancels over HTTP — exactly one succeeds', async () => {
      const id = await heldReservation();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer()).post(`/reservations/${id}/cancel`),
        ),
      );

      const ok = results.filter((r) => r.status === 200);
      // Losers are 409 either from the version check or from the aggregate
      // refusing a second cancel — both are correct, both are conflicts.
      const conflict = results.filter((r) => r.status === 409);

      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(4);
      expect(await versionOf(id)).toBe(1);
    });
  });

  describe('cancelling releases the seats', () => {
    it('frees the seat immediately, before the TTL', async () => {
      const event = await request(app.getHttpServer())
        .post('/events')
        .send({
          name: `Release ${randomUUID()}`,
          salesOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
          salesCloseAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          startsAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          seatMap: { rows: 1, seatsPerRow: 2 },
          priceMinor: 5000,
          currency: 'GBP',
        })
        .expect(201);

      const seats = await request(app.getHttpServer())
        .get(`/events/${event.body.id}/seats`)
        .expect(200);
      const seatId = seats.body.seats[0].id as string;

      const held = await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId: event.body.id, holderId: randomUUID(), seatIds: [seatId] })
        .expect(201);

      // Taken while held...
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId: event.body.id, holderId: randomUUID(), seatIds: [seatId] })
        .expect(409);

      await request(app.getHttpServer()).post(`/reservations/${held.body.id}/cancel`).expect(200);

      // ...and available again the moment it is cancelled, with the original
      // TTL still far in the future.
      await request(app.getHttpServer())
        .post('/reservations')
        .send({ eventId: event.body.id, holderId: randomUUID(), seatIds: [seatId] })
        .expect(201);
    });
  });

  describe('guards', () => {
    it('refuses to cancel twice', async () => {
      const id = await heldReservation();

      await request(app.getHttpServer()).post(`/reservations/${id}/cancel`).expect(200);
      await request(app.getHttpServer()).post(`/reservations/${id}/cancel`).expect(409);
    });

    it('returns 404 for an unknown reservation', async () => {
      await request(app.getHttpServer()).post(`/reservations/${randomUUID()}/cancel`).expect(404);
    });
  });
});
