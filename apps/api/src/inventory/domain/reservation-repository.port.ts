import { type Reservation, type ReservationId } from './reservation.js';

export interface ReservationRepository {
  /**
   * Persists the reservation and the seat claims it owns, in one write.
   *
   * Must be called inside the same transaction that took the seat locks —
   * committing the claim is what releases them.
   */
  save(reservation: Reservation): Promise<void>;

  findById(id: ReservationId): Promise<Reservation | null>;

  /**
   * Persists a state change, asserting the version that was read.
   *
   * Throws `ConcurrentModification` when the row has moved on — the update
   * would otherwise silently overwrite someone else's change. The caller
   * re-reads and retries; nothing is locked in the meantime.
   *
   * Contrast with holding seats (TICK-8), which is genuinely contended and so
   * takes a pessimistic lock instead. See docs/concurrency.md.
   */
  updateState(reservation: Reservation): Promise<void>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
