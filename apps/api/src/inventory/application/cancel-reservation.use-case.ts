import { DomainError } from '../../shared/domain/domain-error.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type Reservation, type ReservationId } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';

export class ReservationNotFound extends DomainError {
  constructor(id: ReservationId) {
    super(`Reservation ${id} not found`);
  }
}

/**
 * Cancels a hold, releasing its seats.
 *
 * This is the **optimistic** counterpart to TICK-8's pessimistic hold, and the
 * contrast is the point of TICK-9:
 *
 *   Holding a seat is contended — thousands of buyers race for the same row —
 *   so it takes a lock and makes losers wait.
 *
 *   Cancelling is not. Only the holder cancels their own hold, so a conflict
 *   means the same holder double-clicked, or a sweeper expired it in the same
 *   instant. Taking a lock for that would cost every request to protect
 *   against something that almost never happens; asserting the version costs
 *   nothing until it does.
 */
export class CancelReservationUseCase {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(id: ReservationId): Promise<Reservation> {
    return this.transaction.run(async () => {
      const reservation = await this.reservations.findById(id);

      if (!reservation) {
        throw new ReservationNotFound(id);
      }

      // The aggregate decides whether this transition is legal — cancelling a
      // CONFIRMED or already-CANCELLED hold throws InvalidStateTransition.
      reservation.cancel();

      // Asserts the version read a moment ago. Anyone who changed the row in
      // between wins, and this call is rejected rather than overwriting them.
      await this.reservations.updateState(reservation);

      return reservation;
    });
  }
}
