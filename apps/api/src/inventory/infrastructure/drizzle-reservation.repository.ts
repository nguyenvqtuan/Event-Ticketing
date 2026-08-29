import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseContext } from '../../shared/infrastructure/database/database.module.js';
import { reservationItems, reservations } from '../../shared/infrastructure/database/schema.js';
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
    });
  }
}
