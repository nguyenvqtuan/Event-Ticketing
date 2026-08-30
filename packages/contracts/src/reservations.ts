/** Requests and responses for holds — the Inventory context's write path. */
import { type IsoDateTime } from './events.js';

export type ReservationState = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

/** POST /reservations */
export interface CreateReservationRequest {
  readonly eventId: string;
  readonly holderId: string;
  /** 1–20 distinct seats. All held, or none. */
  readonly seatIds: readonly string[];
}

export interface ReservationResponse {
  readonly id: string;
  readonly eventId: string;
  readonly holderId: string;
  readonly seatIds: readonly string[];
  readonly state: ReservationState;
  readonly createdAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

/** POST /reservations/:id/confirm */
export interface ConfirmReservationResponse {
  readonly id: string;
  readonly state: ReservationState;
  readonly seatIds: readonly string[];
}

/** POST /reservations/:id/cancel */
export interface CancelReservationResponse {
  readonly id: string;
  readonly state: ReservationState;
  readonly seatIds: readonly string[];
  readonly version: number;
}

/** GET /reservations/:id */
export interface ReservationDetailResponse {
  readonly id: string;
  readonly eventId: string;
  readonly holderId: string;
  readonly seatIds: readonly string[];
  readonly state: ReservationState;
  readonly expiresAt: IsoDateTime;
  readonly version: number;
  /**
   * Expiry is a fact about the clock, not a stored flag: a hold past its TTL
   * reports `expired` even while its row still says PENDING. Branch on this
   * rather than comparing `expiresAt` against the browser's clock, which may
   * disagree with the server's.
   */
  readonly expired: boolean;
  readonly holdsSeats: boolean;
}
