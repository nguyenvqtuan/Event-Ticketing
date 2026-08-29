import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { reservationItems, reservations } from '../../shared/infrastructure/database/schema.js';
import { ConcurrentModification } from '../../shared/domain/domain-error.js';
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
}
