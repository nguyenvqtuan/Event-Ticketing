/** Requests and responses for the Payment context. */

export type OrderState = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';

/** An amount in the currency's smallest unit — pence, cents. Never a float. */
export interface MoneyAmount {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * POST /reservations/:id/pay
 *
 * **Requires an `Idempotency-Key` header.** A client retrying after a timeout
 * cannot know whether the first attempt charged, so the key is the only thing
 * preventing a double charge — replaying it returns the first order rather
 * than creating a second. The client generates one key per checkout attempt
 * and reuses it across retries of that attempt.
 */
export interface PayRequest {
  /** Must equal the seats' total, or the API answers 422. */
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PayResponse {
  readonly orderId: string;
  readonly reservationId: string;
  readonly state: OrderState;
  readonly seatIds: readonly string[];
  readonly paid: MoneyAmount;
}

/**
 * POST /orders/:id/refund — also requires an `Idempotency-Key`.
 *
 * Two different protections apply: the key stops a RETRY re-running, while the
 * order's state machine stops a genuine SECOND refund even under a fresh key.
 */
export interface RefundResponse {
  readonly orderId: string;
  readonly state: OrderState;
  readonly seatIds: readonly string[];
  readonly refunded: MoneyAmount;
}
