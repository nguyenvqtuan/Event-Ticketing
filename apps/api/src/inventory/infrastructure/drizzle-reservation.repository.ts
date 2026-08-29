import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { reservationItems, reservations } from '../../shared/infrastructure/database/schema.js';
import { ConcurrentModification, InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { Reservation, type ReservationId } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';

@Injectable()
export class DrizzleReservationRepository implements ReservationRepository {
  constructor(private readonly context: DatabaseContext) {}

  async save(reservation: Reservation): Promise<void> {
    const db = this.context.db;

    await db.insert(reservations).values({
      id: reservation.id,
      eventId: reservation.eventId,
      holderId: reservation.holderId,
      state: reservation.state,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
    });

    // The claim's validity period IS the hold: [createdAt, expiresAt). When it
    // lapses the seat frees itself, with no sweeper and no second write — see
    // docs/domain.md. The exclusion constraint rejects an overlap here, which
    // is the backstop behind the FOR UPDATE lock taken moments earlier.
    await db.insert(reservationItems).values(
      reservation.seatIds.map((seatId) => ({
        reservationId: reservation.id,
        seatId,
        claimState: 'HELD',
        validDuring:
          sql`tstzrange(${reservation.createdAt.toISOString()}::timestamptz, ${reservation.expiresAt.toISOString()}::timestamptz)` as unknown as string,
      })),
    );
  }

  async findById(id: ReservationId): Promise<Reservation | null> {
    const [row] = await this.context.db
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);

    if (!row) return null;

    const items = await this.context.db
      .select({ seatId: reservationItems.seatId })
      .from(reservationItems)
      .where(eq(reservationItems.reservationId, id));

    return Reservation.rehydrate({
      id: row.id,
      eventId: row.eventId,
      holderId: row.holderId,
      seatIds: items.map((item) => item.seatId),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      state: row.state as Reservation['state'],
      version: row.version,
    });
  }

  /**
   * Optimistic update: `WHERE id = ? AND version = ?`, bumping the version in
   * the same statement so the check and the increment are one atomic act.
   *
   * Zero rows affected is the whole mechanism — it means the row moved since
   * we read it, so this write would have lost someone else's change. No
   * trigger auto-increments `version`, deliberately: a trigger plus this
   * statement would bump it twice, and having the assertion visible in the
   * UPDATE is the point.
   */
  async updateState(reservation: Reservation): Promise<void> {
    const db = this.context.db;

    const updated = await db
      .update(reservations)
      .set({
        state: reservation.state,
        version: reservation.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(eq(reservations.id, reservation.id), eq(reservations.version, reservation.version)),
      )
      .returning({ id: reservations.id });

    if (updated.length === 0) {
      throw new ConcurrentModification('Reservation', reservation.id);
    }

    // A terminal state releases the seats. Setting claim_state to RELEASED
    // drops the rows out of the exclusion constraint, so the seats become
    // available immediately rather than at the end of the original TTL.
    if (reservation.state === 'CANCELLED' || reservation.state === 'EXPIRED') {
      await db
        .update(reservationItems)
        .set({ claimState: 'RELEASED', updatedAt: new Date() })
        .where(
          and(
            eq(reservationItems.reservationId, reservation.id),
            inArray(reservationItems.claimState, ['HELD']),
          ),
        );
    }
  }

  /**
   * Batch-claims lapsed holds with `FOR UPDATE SKIP LOCKED`.
   *
   * SKIP LOCKED is doing two jobs at once:
   *
   *   Multi-instance — @Cron fires on every replica. Without SKIP LOCKED they
   *   would all block on the same rows and serialise; with it each takes a
   *   disjoint batch and they share the work.
   *
   *   Mutual exclusion with payment — a reservation being confirmed holds a
   *   row lock (findByIdForUpdate), so this scan passes straight over it
   *   rather than expiring a hold that is mid-checkout. That is the AC's
   *   "don't release a reservation that was just paid for", and it costs
   *   nothing extra.
   *
   * Idempotent: the WHERE clause only matches PENDING rows past their TTL, so
   * a second run over the same reservations matches nothing.
   */
  async expireLapsed(limit: number): Promise<number> {
    const db = this.context.db;

    const claimed = await db.execute<{ id: string }>(sql`
      SELECT id FROM reservations
       WHERE state = 'PENDING' AND expires_at < now()
       ORDER BY expires_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
    `);

    const ids = claimed.rows.map((row) => row.id);
    if (ids.length === 0) return 0;

    await db
      .update(reservations)
      .set({ state: 'EXPIRED', version: sql`version + 1`, updatedAt: new Date() })
      .where(inArray(reservations.id, ids));

    // Drop the dead claims out of the exclusion index. The seats were already
    // free — their ranges had lapsed — so this frees index space, not seats.
    await db
      .update(reservationItems)
      .set({ claimState: 'RELEASED', updatedAt: new Date() })
      .where(
        and(inArray(reservationItems.reservationId, ids), eq(reservationItems.claimState, 'HELD')),
      );

    return ids.length;
  }

  async findByIdForUpdate(id: ReservationId): Promise<Reservation | null> {
    // Locks the row so the sweeper's SKIP LOCKED scan passes over it.
    const locked = await this.context.db.execute<{ id: string }>(sql`
      SELECT id FROM reservations WHERE id = ${id} FOR UPDATE
    `);

    if (locked.rows.length === 0) return null;

    return this.findById(id);
  }

  async totalFor(id: ReservationId): Promise<Money> {
    const result = await this.context.db.execute<{ total: number; currency: string }>(sql`
      SELECT COALESCE(SUM(s.price_minor), 0)::int AS total,
             MIN(s.currency)                      AS currency,
             COUNT(DISTINCT s.currency)::int      AS currencies
        FROM reservation_items ri
        JOIN seats s ON s.id = ri.seat_id
       WHERE ri.reservation_id = ${id}
    `);

    const row = result.rows[0] as
      { total: number; currency: string | null; currencies: number } | undefined;

    if (!row || row.currency === null) {
      throw new InvariantViolation(`Reservation ${id} has no seats to price`);
    }
    // Money refuses to mix currencies, and so should a reservation.
    if (row.currencies > 1) {
      throw new InvariantViolation(`Reservation ${id} spans more than one currency`);
    }

    return Money.of(Number(row.total), row.currency);
  }

  async extendClaimsIndefinitely(id: ReservationId): Promise<void> {
    // Upper bound becomes 'infinity', so the claim never lapses. The lower
    // bound is preserved, keeping the audit trail of when the hold began.
    await this.context.db.execute(sql`
      UPDATE reservation_items
         SET valid_during = tstzrange(lower(valid_during), 'infinity'),
             updated_at = now()
       WHERE reservation_id = ${id}
         AND claim_state = 'HELD'
    `);
  }
}
