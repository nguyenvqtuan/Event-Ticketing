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
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
