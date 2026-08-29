import { type Reservation, type ReservationId } from './reservation.js';

/** A seat of a reservation, priced from the catalogue. */
export interface PricedSeatRow {
  readonly seatId: string;
  readonly seatCode: string;
  readonly priceMinor: number;
  readonly currency: string;
}

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

  /**
   * Claims a batch of lapsed holds and expires them, returning how many.
   *
   * Bookkeeping, not correctness: a lapsed claim already stops covering its
   * seat the instant `valid_during` no longer contains now(), so the seat is
   * sellable whether or not this ever runs. What this does is make `state`
   * honest, keep the partial index small, and drop dead rows out of the
   * exclusion index.
   *
   * Implementations must use `FOR UPDATE SKIP LOCKED` so that (a) sweepers on
   * different replicas take disjoint batches instead of queueing, and (b) a
   * reservation currently locked by an in-flight confirm is skipped rather
   * than expired underneath it.
   */
  expireLapsed(limit: number): Promise<number>;

  /**
   * Loads a reservation and locks its row for the rest of the transaction.
   *
   * Taking the lock is what excludes the sweeper: its SKIP LOCKED scan passes
   * over any row already locked here.
   */
  findByIdForUpdate(id: ReservationId): Promise<Reservation | null>;

  /**
   * Extends the claims of a confirmed reservation so they never lapse.
   *
   * Without this the seats would free themselves at the original TTL while
   * payment was still in flight — and the sweeper, which only looks at
   * PENDING rows, would not even notice. That is a double-sell.
   */
  extendClaimsIndefinitely(id: ReservationId): Promise<void>;

  /**
   * The reservation's seats with their catalogue prices.
   *
   * Read at payment time rather than stored on the hold: the price charged is
   * the one in effect now, and it is frozen onto the order lines at that
   * moment so a later catalogue change cannot alter it.
   */
  pricedSeatsFor(id: ReservationId): Promise<readonly PricedSeatRow[]>;

  /**
   * HELD → SOLD, with validity extended to infinity.
   *
   * A sold seat must never free itself at the original TTL, and the sweeper
   * only looks at PENDING reservations, so it would never notice.
   */
  markClaimsSold(id: ReservationId): Promise<void>;

  /**
   * Releases a reservation's claims, whatever state they are in.
   *
   * Used by a refund: a SOLD claim never lapses on its own, so returning the
   * seat to sale requires dropping the claim out of the exclusion constraint.
   */
  releaseClaims(id: ReservationId): Promise<void>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');
