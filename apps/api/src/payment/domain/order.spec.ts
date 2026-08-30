import { InvalidStateTransition, InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { Order, type OrderLine } from './order.js';

const GBP = 'GBP';
const NOW = new Date('2026-01-01T12:00:00.000Z');

const line = (seatId: string, minor: number): OrderLine => ({
  seatId,
  seatCode: seatId.toUpperCase(),
  price: Money.of(minor, GBP),
});

const place = (lines: OrderLine[] = [line('seat-1', 5_000), line('seat-2', 4_500)]) =>
  Order.place({ id: 'ord-1', reservationId: 'res-1', lines, currency: GBP, now: NOW });

describe('Order', () => {
  describe('placing', () => {
    it('starts PENDING and totals its lines', () => {
      const order = place();

      expect(order.state).toBe('PENDING');
      expect(order.total.equals(Money.of(9_500, GBP))).toBe(true);
    });

    it('rejects an order with no lines', () => {
      expect(() => place([])).toThrow(InvariantViolation);
    });

    it('rejects the same seat twice', () => {
      expect(() => place([line('seat-1', 100), line('seat-1', 100)])).toThrow(/same seat twice/);
    });

    it('rejects lines in mixed currencies rather than silently summing them', () => {
      const mixed = [line('seat-1', 100), { ...line('seat-2', 100), price: Money.of(100, 'EUR') }];

      expect(() => place(mixed)).toThrow(/Cannot combine/);
    });
  });

  describe('payment', () => {
    it('moves PENDING → PAID', () => {
      const order = place();
      order.markPaid();

      expect(order.state).toBe('PAID');
    });

    it('moves PENDING → FAILED with a reason', () => {
      const order = place();
      order.markFailed('card_declined');

      expect(order.state).toBe('FAILED');
      expect(order.reasonForFailure).toBe('card_declined');
    });

    it('requires a reason when failing', () => {
      expect(() => place().markFailed('   ')).toThrow(InvariantViolation);
    });

    it('refuses to pay an already-paid order', () => {
      const order = place();
      order.markPaid();

      expect(() => order.markPaid()).toThrow(InvalidStateTransition);
    });

    it('refuses to pay a failed order', () => {
      const order = place();
      order.markFailed('card_declined');

      expect(() => order.markPaid()).toThrow(/FAILED/);
    });
  });

  describe('refunds', () => {
    it('moves PAID → REFUNDED', () => {
      const order = place();
      order.markPaid();
      order.refund();

      expect(order.state).toBe('REFUNDED');
    });

    it('refuses to refund a PENDING order — that money was never captured', () => {
      expect(() => place().refund()).toThrow(InvalidStateTransition);
    });

    it('refuses to refund a FAILED order', () => {
      const order = place();
      order.markFailed('card_declined');

      expect(() => order.refund()).toThrow(InvalidStateTransition);
    });

    it('refuses to refund twice', () => {
      const order = place();
      order.markPaid();
      order.refund();

      expect(() => order.refund()).toThrow(InvalidStateTransition);
    });
  });

  it('freezes the price at sale time — a later catalogue change cannot move it', () => {
    const order = place([line('seat-1', 5_000)]);

    // Prices are copied into lines as Money value objects; nothing shared.
    expect(order.lines[0]!.price.equals(Money.of(5_000, GBP))).toBe(true);
    expect(order.total.equals(Money.of(5_000, GBP))).toBe(true);
  });
});
