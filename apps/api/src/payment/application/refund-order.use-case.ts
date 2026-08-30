import { randomUUID } from 'node:crypto';
import { DomainError } from '../../shared/domain/domain-error.js';
import { type Money } from '../../shared/domain/money.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { LedgerEntry, LedgerTransaction } from '../domain/ledger.js';
import { type Order, type OrderState } from '../domain/order.js';
import {
  type LedgerRepository,
  type OrderRepository,
  type SeatClaimPort,
} from '../domain/payment-repository.port.js';

export class OrderNotFound extends DomainError {
  constructor(id: string) {
    super(`Order ${id} not found`);
  }
}

export interface RefundResult {
  readonly orderId: string;
  readonly state: OrderState;
  readonly refunded: Money;
  readonly seatIds: readonly string[];
}

/**
 * Refunds a paid order by **reversing** it, never by editing it.
 *
 * The original entries stay exactly as written — the database refuses to touch
 * them (TICK-12's append-only triggers), and so does this code. A refund adds
 * a second, mirror-image transaction:
 *
 *   sale      DEBIT  cash            CREDIT ticket_revenue
 *   refund    CREDIT cash            DEBIT  ticket_revenue
 *
 * The two net to zero, and both remain in the history. "What happened to this
 * order?" is answerable forever; with an in-place edit it would not be.
 *
 * Everything happens in one transaction: an order marked REFUNDED whose
 * reversing entries failed to write would be a lie in the books.
 */
export class RefundOrderUseCase {
  constructor(
    private readonly orders: OrderRepository,
    private readonly ledger: LedgerRepository,
    private readonly seats: SeatClaimPort,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(orderId: string, now: Date): Promise<RefundResult> {
    return this.transaction.run(async () => {
      const order = await this.orders.findByIdForUpdate(orderId);

      if (!order) {
        throw new OrderNotFound(orderId);
      }

      // The aggregate refuses anything but PAID → REFUNDED. This is what stops
      // a double refund: the second attempt finds the order already REFUNDED
      // and throws, regardless of idempotency keys.
      order.refund();

      // Optimistic: asserts the version read a moment ago. Refunding is
      // low-contention, so this costs nothing until it matters.
      await this.orders.updateState(order);

      await this.postReversal(order, now);

      // Seats return to sale. Availability is derived from live claims, so
      // releasing them IS the release — there is no separate state to set.
      await this.seats.releaseSeats(order.reservationId);

      return {
        orderId: order.id,
        state: order.state,
        refunded: order.total,
        seatIds: order.lines.map((line) => line.seatId),
      };
    });
  }

  /**
   * Posts the mirror image of the sale.
   *
   * `LedgerTransaction.post` still enforces balance, so a reversal cannot be
   * lopsided either — a refund is an ordinary transaction that happens to
   * point the other way, not a special case that bypasses the rules.
   */
  private async postReversal(order: Order, now: Date): Promise<void> {
    const currency = order.total.currency;
    const cash = await this.ledger.accountId('cash', currency);
    const revenue = await this.ledger.accountId('ticket_revenue', currency);

    const reversal = LedgerTransaction.post({
      id: randomUUID(),
      entries: [
        LedgerEntry.of(cash, 'CREDIT', order.total),
        LedgerEntry.of(revenue, 'DEBIT', order.total),
      ],
      occurredAt: now,
      // Shares the sale's prefix, so one query nets everything for the order.
      reference: `order:${order.id}:refund`,
      currency,
    });

    await this.ledger.post(reversal);
  }
}
