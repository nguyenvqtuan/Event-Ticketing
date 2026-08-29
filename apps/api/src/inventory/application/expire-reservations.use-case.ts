import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';

/**
 * Sweeps lapsed holds: PENDING past its TTL → EXPIRED, claims → RELEASED.
 *
 * **This is housekeeping, not the mechanism.** Availability is derived from
 * whether a claim's `valid_during` still contains `now()`, so a lapsed hold
 * stops covering its seat the instant the TTL passes — with no write, and
 * whether or not this job ever runs. TICK-10's "lazy layer" is therefore not
 * a check anyone had to write; it falls out of the TICK-4 model.
 *
 * What the sweep buys is hygiene: `state` stops lying, the partial index on
 * PENDING holds stays small, and dead rows leave the exclusion index.
 *
 * Because correctness does not depend on it, the job can fail, lag, or run on
 * six replicas at once without risking a double-booking.
 */
export class ExpireReservationsUseCase {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  /**
   * Expires up to `batchSize` lapsed holds and returns how many.
   *
   * Bounded on purpose: an unbounded sweep after an outage could lock a very
   * large number of rows in one transaction. Running often and small beats
   * running rarely and huge.
   */
  async execute(batchSize = 500): Promise<number> {
    return this.transaction.run(() => this.reservations.expireLapsed(batchSize));
  }
}
