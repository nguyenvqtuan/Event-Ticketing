import { DomainError } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type EventId } from '../domain/event.js';
import { type SeatRepository } from '../domain/inventory-repository.port.js';
import { Reservation } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { type SeatId } from '../domain/seat.js';
import { EventNotFound } from './get-event-overview.use-case.js';
import { type EventRepository } from '../domain/inventory-repository.port.js';

/**
 * Some requested seats cannot be held. Carries the offending ids so the caller
 * learns *which* seats lost the race, not merely that something did.
 */
export class SeatsUnavailable extends DomainError {
  constructor(
    readonly unavailable: readonly SeatId[],
    readonly missing: readonly SeatId[],
  ) {
    const parts = [
      unavailable.length > 0 ? `already held or sold: ${unavailable.join(', ')}` : null,
      missing.length > 0 ? `not found for this event: ${missing.join(', ')}` : null,
    ].filter(Boolean);

    super(`Cannot hold seats — ${parts.join('; ')}`);
  }
}

/** Sales are closed, so nothing may be held regardless of availability. */
export class SalesClosed extends DomainError {
  constructor(eventId: EventId) {
    super(`Event ${eventId} is not currently on sale`);
  }
}

export interface HoldSeatsCommand {
  readonly id: string;
  readonly eventId: EventId;
  readonly holderId: string;
  readonly seatIds: readonly SeatId[];
  readonly now: Date;
  readonly ttlSeconds: number;
}

/**
 * Holds seats for a limited time — the system's contended write path.
 *
 * Correctness rests on three layers, deliberately:
 *
 *   1. `FOR UPDATE` on the seat rows, taken in seat-id order. Serialises
 *      competing requests so a loser waits and then sees the winner's
 *      committed claim, rather than both racing to write.
 *   2. The exclusion constraint from TICK-5, which makes overlapping claims
 *      unrepresentable even for a writer that forgot to take the lock.
 *   3. The `Reservation` aggregate, which refuses a hold with no seats,
 *      duplicate seats, or a non-positive TTL before anything is written.
 *
 * Layer 1 gives good errors; layer 2 gives the actual guarantee.
 */
export class HoldSeatsUseCase {
  constructor(
    private readonly events: EventRepository,
    private readonly seats: SeatRepository,
    private readonly reservations: ReservationRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(command: HoldSeatsCommand): Promise<Reservation> {
    const { eventId, seatIds, now } = command;

    return this.transaction.run(async () => {
      const event = await this.events.findById(eventId);

      if (!event) {
        throw new EventNotFound(eventId);
      }
      // The sales-window rule lives in the aggregate; this only enforces it.
      if (!event.isOnSale(now)) {
        throw new SalesClosed(eventId);
      }

      // Locks the seats, then reports what cannot be held. Everything after
      // this point is protected from concurrent claims on the same seats.
      const availability = await this.seats.lockAndCheckAvailability(eventId, seatIds);

      // All-or-nothing: one unavailable seat fails the entire request rather
      // than silently holding a subset the caller did not ask for.
      if (availability.unavailable.length > 0 || availability.missing.length > 0) {
        throw new SeatsUnavailable(availability.unavailable, availability.missing);
      }

      const reservation = Reservation.open({
        id: command.id,
        eventId,
        holderId: command.holderId,
        seatIds,
        now,
        ttlSeconds: command.ttlSeconds,
      });

      await this.reservations.save(reservation);

      return reservation;
    });
  }
}
