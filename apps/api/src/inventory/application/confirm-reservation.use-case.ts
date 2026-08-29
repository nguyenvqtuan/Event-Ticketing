import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type Reservation, type ReservationId } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { ReservationNotFound } from './cancel-reservation.use-case.js';

/**
 * Confirms a hold — the step a payment attempt begins with.
 *
 * This is the writer that races the expiry sweeper, and the ordering inside
 * the transaction is what makes the race safe:
 *
 *   1. Lock the reservation row. The sweeper's `SKIP LOCKED` scan now passes
 *      over it, so it cannot be expired underneath us.
 *   2. Ask the aggregate to confirm. It refuses if the TTL has already
 *      lapsed — expiry is a fact about the clock, not about whether the
 *      sweeper has run, so a late payment is rejected even when the row still
 *      says PENDING.
 *   3. Extend the claims so the seats cannot free themselves while payment is
 *      in flight.
 *
 * Together: payment wins if it arrives before the TTL, and is rejected after.
 */
export class ConfirmReservationUseCase {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(id: ReservationId, now: Date): Promise<Reservation> {
    return this.transaction.run(async () => {
      const reservation = await this.reservations.findByIdForUpdate(id);

      if (!reservation) {
        throw new ReservationNotFound(id);
      }

      // Throws InvalidStateTransition when the TTL has passed, or when the
      // hold is already CONFIRMED/CANCELLED/EXPIRED.
      reservation.confirm(now);

      await this.reservations.updateState(reservation);

      // Only after the state change is committed to: a confirmed hold must
      // outlive its original TTL, otherwise the seats quietly become
      // available again mid-payment and can be sold twice.
      await this.reservations.extendClaimsIndefinitely(id);

      return reservation;
    });
  }
}
