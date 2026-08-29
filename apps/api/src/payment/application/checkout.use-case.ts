import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { LedgerEntry, LedgerTransaction } from '../domain/ledger.js';
import { Order, type OrderLine } from '../domain/order.js';
import {
  type LedgerRepository,
  type OrderRepository,
  type SeatClaimPort,
} from '../domain/payment-repository.port.js';

/** The amount offered does not match what the seats actually cost. */
export class AmountMismatch extends DomainError {
  constructor(
    readonly expected: Money,
    readonly offered: Money,
  ) {
    super(`Expected ${expected.toString()} but the request offered ${offered.toString()}`);
  }
}

export interface CheckoutCommand {
  readonly reservationId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly now: Date;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly reservationId: string;
  readonly state: string;
  readonly total: Money;
  readonly seatIds: readonly string[];
}

/**
 * Takes payment for a confirmed hold: seats SOLD, order PAID, ledger written —
 * **all in one transaction, or none of it**.
 *
 * The failure this guards against is the one that actually happens: a seat
 * marked SOLD while the ledger write failed, so a customer holds a ticket the
 * books have no record of. There is no compensating action that fixes that
 * cleanly after the fact, which is why it is a transaction rather than a saga.
 *
 * Note what this use case does NOT see: Inventory's `Reservation`. It receives
 * a translated view — ids and priced lines — through `SeatClaimPort`. That is
 * the context seam from docs/domain.md, and it means a change to the hold flow
 * cannot silently alter billing.
 */
export class CheckoutUseCase {
  constructor(
    private readonly seats: SeatClaimPort,
    private readonly orders: OrderRepository,
    private readonly ledger: LedgerRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(command: CheckoutCommand): Promise<CheckoutResult> {
    const { reservationId, currency, now } = command;

    return this.transaction.run(async () => {
      // Confirms the hold and marks its seats SOLD. Throws when the hold has
      // lapsed or is not PENDING — an EXPIRED or already-sold reservation
      // cannot be paid.
      const claimed = await this.seats.claimForPayment(reservationId, now);

      const lines: OrderLine[] = claimed.lines.map((seat) => ({
        seatId: seat.seatId,
        seatCode: seat.seatCode,
        // Copied, not referenced: a later catalogue price change must not
        // alter what this customer paid.
        price: seat.price,
      }));

      const order = Order.place({
        id: randomUUID(),
        reservationId,
        lines,
        currency,
        now,
      });

      // Check the amount against the order the domain actually built, rather
      // than against a separately-computed total that could drift from it.
      const offered = Money.of(command.amountMinor, currency);
      if (!order.total.equals(offered)) {
        throw new AmountMismatch(order.total, offered);
      }

      // Payment succeeded. The ticket calls this a CONFIRMED order; this
      // domain's state machine calls the same state PAID (see docs/domain.md).
      order.markPaid();
      await this.orders.save(order);

      await this.postRevenue(order.id, order.total, currency, now);

      return {
        orderId: order.id,
        reservationId,
        state: order.state,
        total: order.total,
        seatIds: lines.map((line) => line.seatId),
      };
    });
  }

  /**
   * Records the sale: cash increases, revenue is earned.
   *
   *   DEBIT  cash            (asset up)
   *   CREDIT ticket_revenue  (revenue earned)
   *
   * `LedgerTransaction.post` refuses to construct anything unbalanced, and the
   * deferred database trigger refuses to commit one. Both, deliberately: the
   * domain gives a good error, the database guarantees nobody bypasses it.
   */
  private async postRevenue(
    orderId: string,
    total: Money,
    currency: string,
    now: Date,
  ): Promise<void> {
    const cash = await this.ledger.accountId('cash', currency);
    const revenue = await this.ledger.accountId('ticket_revenue', currency);

    const transaction = LedgerTransaction.post({
      id: randomUUID(),
      entries: [LedgerEntry.of(cash, 'DEBIT', total), LedgerEntry.of(revenue, 'CREDIT', total)],
      occurredAt: now,
      reference: `order:${orderId}`,
      currency,
    });

    await this.ledger.post(transaction);
  }
}
