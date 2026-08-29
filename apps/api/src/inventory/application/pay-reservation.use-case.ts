import { DomainError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type Reservation, type ReservationId } from '../domain/reservation.js';
import { type ReservationRepository } from '../domain/reservation-repository.port.js';
import { ReservationNotFound } from './cancel-reservation.use-case.js';

/** The amount offered does not match what the seats actually cost. */
export class AmountMismatch extends DomainError {
  constructor(
    readonly expected: Money,
    readonly offered: Money,
  ) {
    super(`Expected ${expected.toString()} but the request offered ${offered.toString()}`);
  }
}

export interface PayReservationCommand {
  readonly reservationId: ReservationId;
  readonly amountMinor: number;
  readonly currency: string;
  readonly now: Date;
}

export interface PaymentResult {
  readonly reservation: Reservation;
  readonly amount: Money;
}

/**
 * Pays for a held reservation.
 *
 * **Scope:** TICK-11 is about idempotency, so the side effect here is the
 * minimum that is genuinely a payment — verify the amount, then confirm the
 * hold so its seats can no longer lapse. TICK-12 grows this into creating a
 * CONFIRMED order, moving seats HELD → SOLD and writing balanced ledger
 * entries, all inside this same transaction.
 *
 * That growth is the real test of the idempotency design: because the key row
 * is written in the transaction that wraps this work, adding more writes here
 * cannot break the guarantee.
 */
export class PayReservationUseCase {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(command: PayReservationCommand): Promise<PaymentResult> {
    const { reservationId, now } = command;

    return this.transaction.run(async () => {
      // Locks the row, so the expiry sweeper skips it while payment runs.
      const reservation = await this.reservations.findByIdForUpdate(reservationId);

      if (!reservation) {
        throw new ReservationNotFound(reservationId);
      }

      const expected = await this.reservations.totalFor(reservationId);
      const offered = Money.of(command.amountMinor, command.currency);

      // Check the amount before confirming: a mismatched payment should leave
      // the reservation untouched, not half-processed.
      if (!expected.equals(offered)) {
        throw new AmountMismatch(expected, offered);
      }

      // Throws when the TTL has lapsed or the hold is already terminal —
      // this is what makes an EXPIRED reservation unpayable.
      reservation.confirm(now);

      await this.reservations.updateState(reservation);

      // A paid hold must outlive its original TTL, or the seats would free
      // themselves and could be sold twice.
      await this.reservations.extendClaimsIndefinitely(reservationId);

      return { reservation, amount: expected };
    });
  }
}
