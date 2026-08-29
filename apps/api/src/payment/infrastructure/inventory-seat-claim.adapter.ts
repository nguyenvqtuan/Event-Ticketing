import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../../shared/domain/money.js';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../../inventory/domain/reservation-repository.port.js';
import { ReservationNotFound } from '../../inventory/application/cancel-reservation.use-case.js';
import { type ClaimedSeats, type SeatClaimPort } from '../domain/payment-repository.port.js';

/**
 * Adapter: satisfies Payment's `SeatClaimPort` using Inventory's repository.
 *
 * It lives in payment/infrastructure rather than in Inventory because the
 * dependency must point one way — Payment knows it needs seats claimed;
 * Inventory knows nothing about payment. Translating Inventory's aggregate
 * into Payment's `ClaimedSeats` happens here and nowhere else.
 */
@Injectable()
export class InventorySeatClaimAdapter implements SeatClaimPort {
  constructor(
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservations: ReservationRepository,
  ) {}

  async claimForPayment(reservationId: string, now: Date): Promise<ClaimedSeats> {
    // Locks the row, so the expiry sweeper skips it for the rest of the
    // transaction (SKIP LOCKED — see docs/concurrency.md).
    const reservation = await this.reservations.findByIdForUpdate(reservationId);

    if (!reservation) {
      throw new ReservationNotFound(reservationId);
    }

    // Throws when the TTL has lapsed or the hold is already terminal. This is
    // what makes an EXPIRED or already-sold reservation unpayable, and it
    // consults the clock rather than the stored state.
    reservation.confirm(now);
    await this.reservations.updateState(reservation);

    // HELD → SOLD, validity extended to infinity. A sold seat must never free
    // itself at the original TTL.
    await this.reservations.markClaimsSold(reservationId);

    const lines = await this.reservations.pricedSeatsFor(reservationId);

    return {
      reservationId,
      eventId: reservation.eventId,
      holderId: reservation.holderId,
      lines: lines.map((line) => ({
        seatId: line.seatId,
        seatCode: line.seatCode,
        price: Money.of(line.priceMinor, line.currency),
      })),
    };
  }
}
