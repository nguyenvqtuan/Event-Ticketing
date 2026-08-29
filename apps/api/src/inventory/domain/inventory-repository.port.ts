import { type Event, type EventId } from './event.js';
import { type SeatId } from './seat.js';
import { type SeatBlueprint } from './seat-map.js';

/**
 * Ports for persistence. Interfaces only — the domain states what it needs and
 * `infrastructure/` supplies it, so nothing here imports Drizzle or pg.
 */

export interface EventRepository {
  save(event: Event): Promise<void>;
  findById(id: EventId): Promise<Event | null>;
}

/** A seat as stored, with the identity the database assigned. */
export interface StoredSeat {
  readonly id: SeatId;
  readonly code: string;
  readonly priceMinor: number;
  readonly currency: string;
}

/** Counts of the three derived availability states for one event. */
export interface SeatOverview {
  readonly total: number;
  readonly available: number;
  readonly held: number;
  readonly sold: number;
}

export interface SeatPage {
  readonly seats: readonly StoredSeat[];
  readonly total: number;
}

/** Why a set of seats cannot be held. Both lists empty means "go ahead". */
export interface SeatAvailability {
  /** Requested but not part of this event — a client error, not a race. */
  readonly missing: readonly SeatId[];
  /** Real, but already covered by a live claim. */
  readonly unavailable: readonly SeatId[];
}

export interface SeatRepository {
  /**
   * Inserts seats, ignoring any whose (event_id, code) already exists.
   *
   * Returns how many were actually created, so a caller can tell a fresh
   * generation from a no-op retry. Idempotency is enforced by the unique
   * index, not by reading first — a read-then-write would race.
   */
  createMany(eventId: EventId, seats: readonly SeatBlueprint[]): Promise<number>;

  /**
   * Derived counts. There is no status column; these come from live claims.
   *
   * Note these take no `now` argument, unlike the domain's own rules. Liveness
   * is evaluated inside the query using the database's clock, so availability
   * cannot disagree with the exclusion constraint that enforces it — an app
   * clock skewed from the database's would produce exactly that disagreement.
   */
  overviewFor(eventId: EventId): Promise<SeatOverview>;

  /** Seats of an event filtered by derived availability, paginated. */
  listByAvailability(params: {
    eventId: EventId;
    status: 'AVAILABLE' | 'HELD' | 'SOLD';
    limit: number;
    offset: number;
  }): Promise<SeatPage>;

  /**
   * Takes an exclusive row lock on the given seats, then reports which of them
   * cannot be held.
   *
   * The lock is the point: it serialises everyone competing for a seat, so a
   * loser waits and then sees the winner's committed claim, instead of both
   * discovering the conflict at write time. Must only be called inside a
   * transaction — the lock is released at commit.
   *
   * Implementations must lock in a deterministic order (seat id) so two
   * multi-seat holds that overlap cannot deadlock by grabbing rows in
   * opposite orders.
   */
  lockAndCheckAvailability(eventId: EventId, seatIds: readonly SeatId[]): Promise<SeatAvailability>;
}

/** DI tokens — interfaces do not survive compilation. */
export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');
export const SEAT_REPOSITORY = Symbol('SEAT_REPOSITORY');
