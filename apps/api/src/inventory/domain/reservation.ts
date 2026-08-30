import { InvalidStateTransition, InvariantViolation } from '../../shared/domain/domain-error.js';
import { type EventId } from './event.js';
import { type SeatId } from './seat.js';

export type ReservationId = string;
export type HolderId = string;

/**
 * PENDING is the only state that holds seats. The three terminal states all
 * release them; they differ only in *why*, which matters for reporting and
 * for deciding whether a retry is reasonable.
 */
export type ReservationState = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

/**
 * Aggregate root for the hold flow.
 *
 * Enforces everything that is checkable from inside one reservation: at least
 * one seat, no duplicate seats, one event, and a legal state transition.
 *
 * It CANNOT enforce "a seat is not held by two different reservations" —
 * that spans aggregates, and no amount of in-memory checking makes it safe
 * under concurrency. That invariant belongs to a unique partial index in the
 * database (TICK-5). Pretending otherwise is the classic way to ship a
 * double-booking bug.
 */
export class Reservation {
  private constructor(
    readonly id: ReservationId,
    readonly eventId: EventId,
    readonly holderId: HolderId,
    readonly seatIds: readonly SeatId[],
    readonly createdAt: Date,
    readonly expiresAt: Date,
    private currentState: ReservationState,
  ) {}

  /** Opens a hold over 1..n seats, expiring `ttlSeconds` after `now`. */
  static open(params: {
    id: ReservationId;
    eventId: EventId;
    holderId: HolderId;
    seatIds: readonly SeatId[];
    now: Date;
    ttlSeconds: number;
  }): Reservation {
    const { id, eventId, holderId, seatIds, now, ttlSeconds } = params;

    if (seatIds.length === 0) {
      throw new InvariantViolation('A reservation must hold at least one seat');
    }
    if (new Set(seatIds).size !== seatIds.length) {
      throw new InvariantViolation('A reservation cannot hold the same seat twice');
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new InvariantViolation(`Reservation TTL must be a positive integer: ${ttlSeconds}`);
    }

    const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);

    return new Reservation(id, eventId, holderId, [...seatIds], now, expiresAt, 'PENDING');
  }

  get state(): ReservationState {
    return this.currentState;
  }

  /**
   * Expiry is a fact about time, not a stored flag. A reservation whose TTL
   * has passed is expired whether or not a sweeper has run yet, so every rule
   * below consults this rather than trusting `state`.
   */
  isExpired(now: Date): boolean {
    return this.currentState === 'PENDING' && now >= this.expiresAt;
  }

  get holdsSeats(): boolean {
    return this.currentState === 'PENDING';
  }

  /** PENDING → CONFIRMED. The only path that leads to an Order. */
  confirm(now: Date): void {
    this.assertPending('confirm');

    if (this.isExpired(now)) {
      throw new InvalidStateTransition(
        `Reservation ${this.id} expired at ${this.expiresAt.toISOString()} and cannot be confirmed`,
      );
    }

    this.currentState = 'CONFIRMED';
  }

  /** PENDING → CANCELLED. Deliberate release by the holder. */
  cancel(): void {
    this.assertPending('cancel');
    this.currentState = 'CANCELLED';
  }

  /**
   * PENDING → EXPIRED. Records that the TTL lapsed.
   *
   * Refuses to run early: marking a live hold as expired would release seats
   * a user still legitimately holds.
   */
  expire(now: Date): void {
    this.assertPending('expire');

    if (!this.isExpired(now)) {
      throw new InvalidStateTransition(
        `Reservation ${this.id} does not expire until ${this.expiresAt.toISOString()}`,
      );
    }

    this.currentState = 'EXPIRED';
  }

  private assertPending(action: string): void {
    if (this.currentState !== 'PENDING') {
      throw new InvalidStateTransition(
        `Cannot ${action} reservation ${this.id} in state ${this.currentState}`,
      );
    }
  }
}
