import { InvalidStateTransition, InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';

export type OrderId = string;

export type OrderState = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';

/**
 * One purchased seat, priced at the moment of sale.
 *
 * The price is copied, not referenced. If the seat's catalogue price changes
 * later, what the customer actually paid must not move with it.
 */
export interface OrderLine {
  readonly seatId: string;
  readonly seatCode: string;
  readonly price: Money;
}

/**
 * Aggregate root in the Payment context.
 *
 * Note what it does NOT hold: a `Reservation` object. Payment knows a
 * reservation *id* and a set of priced lines — a translated, published view
 * of what Inventory decided. Sharing the aggregate itself would weld the two
 * contexts together and let a change in the hold flow break billing.
 */
export class Order {
  private constructor(
    readonly id: OrderId,
    readonly reservationId: string,
    readonly lines: readonly OrderLine[],
    readonly total: Money,
    readonly placedAt: Date,
    private currentState: OrderState,
    private failureReason?: string,
    /**
     * Optimistic-concurrency counter, not a business concept — see
     * Reservation for the same pattern and the reasoning.
     */
    readonly version: number = 0,
  ) {}

  /**
   * Reconstitutes an order from storage.
   *
   * Separate from `place()` because a stored order may be in any state.
   * Walking it forward through markPaid()/refund() to reach that state, as an
   * earlier version did, replays transitions that already happened and would
   * reject any state the current rules no longer allow reaching.
   */
  static rehydrate(params: {
    id: OrderId;
    reservationId: string;
    lines: readonly OrderLine[];
    total: Money;
    placedAt: Date;
    state: OrderState;
    failureReason?: string;
    version: number;
  }): Order {
    if (params.lines.length === 0) {
      throw new InvariantViolation(`Stored order ${params.id} has no lines`);
    }

    return new Order(
      params.id,
      params.reservationId,
      [...params.lines],
      params.total,
      params.placedAt,
      params.state,
      params.failureReason,
      params.version,
    );
  }

  /** Placed from a CONFIRMED reservation; payment has not been taken yet. */
  static place(params: {
    id: OrderId;
    reservationId: string;
    lines: readonly OrderLine[];
    currency: string;
    now: Date;
  }): Order {
    const { id, reservationId, lines, currency, now } = params;

    if (lines.length === 0) {
      throw new InvariantViolation('An order must contain at least one line');
    }
    if (new Set(lines.map((line) => line.seatId)).size !== lines.length) {
      throw new InvariantViolation('An order cannot contain the same seat twice');
    }

    const total = Money.sum(
      lines.map((line) => line.price),
      currency,
    );

    return new Order(id, reservationId, [...lines], total, now, 'PENDING');
  }

  get state(): OrderState {
    return this.currentState;
  }

  get reasonForFailure(): string | undefined {
    return this.failureReason;
  }

  /** PENDING → PAID. The seats are now permanently claimed. */
  markPaid(): void {
    this.assertState('PENDING', 'mark paid');
    this.currentState = 'PAID';
  }

  /** PENDING → FAILED. Payment was attempted and declined. */
  markFailed(reason: string): void {
    this.assertState('PENDING', 'mark failed');

    if (!reason.trim()) {
      throw new InvariantViolation('A failed order requires a reason');
    }

    this.currentState = 'FAILED';
    this.failureReason = reason;
  }

  /**
   * PAID → REFUNDED. Only a paid order can be refunded — refunding a pending
   * or failed order would move money that was never captured.
   */
  refund(): void {
    this.assertState('PAID', 'refund');
    this.currentState = 'REFUNDED';
  }

  private assertState(expected: OrderState, action: string): void {
    if (this.currentState !== expected) {
      throw new InvalidStateTransition(
        `Cannot ${action} on order ${this.id} in state ${this.currentState}`,
      );
    }
  }
}
