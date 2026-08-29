import { type Money } from '../../shared/domain/money.js';
import { type LedgerTransaction } from './ledger.js';
import { type Order } from './order.js';

/**
 * Ports for the Payment context. Interfaces only — no Drizzle, no pg.
 */

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findByReservationId(reservationId: string): Promise<Order | null>;

  /** Loads an order and locks its row for the rest of the transaction. */
  findByIdForUpdate(id: string): Promise<Order | null>;

  /**
   * Persists a state change, asserting the version that was read.
   *
   * This is where the `version` column added in TICK-9 finally earns its
   * place: refunding is low-contention, so a lock across the read-modify-write
   * would cost every request to guard against a double-click.
   */
  updateState(order: Order): Promise<void>;
}

export interface LedgerRepository {
  /**
   * Appends a balanced transaction.
   *
   * Append-only: there is no update or delete here, and the database refuses
   * both. A correction is a new, reversing transaction.
   */
  post(transaction: LedgerTransaction): Promise<void>;

  /** Resolves a chart-of-accounts entry. Accounts are reference data. */
  accountId(name: string, currency: string): Promise<string>;
}

/**
 * One seat, priced at the moment of sale.
 *
 * This is the **translated view** Payment receives instead of Inventory's
 * Reservation aggregate — ids and prices, nothing behavioural. It is the seam
 * that lets the hold flow change without breaking billing (see docs/domain.md).
 */
export interface PricedSeat {
  readonly seatId: string;
  readonly seatCode: string;
  readonly price: Money;
}

export interface ClaimedSeats {
  readonly reservationId: string;
  readonly eventId: string;
  readonly holderId: string;
  readonly lines: readonly PricedSeat[];
}

/**
 * What Payment needs from Inventory, expressed in Payment's terms.
 *
 * Implemented by an adapter in payment/infrastructure that delegates to the
 * Inventory repositories. Payment therefore depends on this interface, not on
 * Inventory's aggregates, and the dependency points one way only.
 */
export interface SeatClaimPort {
  /**
   * Confirms the hold and marks its seats SOLD, returning the priced lines.
   *
   * Throws if the hold has lapsed or is not PENDING — which is what makes an
   * EXPIRED or already-sold reservation unpayable. Must run inside the
   * caller's transaction so it rolls back with everything else.
   */
  claimForPayment(reservationId: string, now: Date): Promise<ClaimedSeats>;

  /**
   * Releases a reservation's seats after a refund.
   *
   * Availability is derived from live claims, so marking them RELEASED drops
   * them out of the exclusion constraint and the seats are sellable again
   * immediately — no separate "make available" step exists, or is needed.
   */
  releaseSeats(reservationId: string): Promise<void>;
}

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
export const SEAT_CLAIM_PORT = Symbol('SEAT_CLAIM_PORT');
