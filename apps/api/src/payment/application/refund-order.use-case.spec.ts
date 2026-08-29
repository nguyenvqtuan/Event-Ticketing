import { InvalidStateTransition } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type LedgerTransaction } from '../domain/ledger.js';
import { Order, type OrderLine } from '../domain/order.js';
import {
  type LedgerRepository,
  type OrderRepository,
  type SeatClaimPort,
} from '../domain/payment-repository.port.js';
import { OrderNotFound, RefundOrderUseCase } from './refund-order.use-case.js';

const GBP = 'GBP';
const NOW = new Date('2026-03-01T12:00:00.000Z');

const line = (seatId: string, minor: number): OrderLine => ({
  seatId,
  seatCode: seatId.toUpperCase(),
  price: Money.of(minor, GBP),
});

const paidOrder = () => {
  const order = Order.place({
    id: 'ord-1',
    reservationId: 'res-1',
    lines: [line('seat-1', 5_000), line('seat-2', 4_500)],
    currency: GBP,
    now: NOW,
  });
  order.markPaid();

  return order;
};

class FakeOrders implements OrderRepository {
  current: Order | null = paidOrder();
  lockedFor: string | null = null;
  updated: Order[] = [];

  save() {
    return Promise.resolve();
  }
  findByReservationId() {
    return Promise.resolve(this.current);
  }
  findByIdForUpdate(id: string) {
    this.lockedFor = id;
    return Promise.resolve(this.current);
  }
  updateState(order: Order) {
    this.updated.push(order);
    return Promise.resolve();
  }
}

class FakeLedger implements LedgerRepository {
  posted: LedgerTransaction[] = [];
  post(transaction: LedgerTransaction) {
    this.posted.push(transaction);
    return Promise.resolve();
  }
  accountId(name: string, currency: string) {
    return Promise.resolve(`acct-${name}-${currency}`);
  }
}

class FakeSeats implements SeatClaimPort {
  released: string[] = [];
  claimForPayment() {
    return Promise.reject(new Error('not used'));
  }
  releaseSeats(reservationId: string) {
    this.released.push(reservationId);
    return Promise.resolve();
  }
}

class PassthroughRunner implements TransactionRunner {
  calls = 0;
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.calls++;
    return work();
  }
}

describe('RefundOrderUseCase', () => {
  let orders: FakeOrders;
  let ledger: FakeLedger;
  let seats: FakeSeats;
  let transaction: PassthroughRunner;
  let useCase: RefundOrderUseCase;

  beforeEach(() => {
    orders = new FakeOrders();
    ledger = new FakeLedger();
    seats = new FakeSeats();
    transaction = new PassthroughRunner();
    useCase = new RefundOrderUseCase(orders, ledger, seats, transaction);
  });

  it('refunds a paid order and returns the seats to sale', async () => {
    const result = await useCase.execute('ord-1', NOW);

    expect(result.state).toBe('REFUNDED');
    expect(result.refunded.equals(Money.of(9_500, GBP))).toBe(true);
    expect(seats.released).toEqual(['res-1']);
  });

  it('REVERSES the sale rather than editing it: credit cash, debit revenue', async () => {
    await useCase.execute('ord-1', NOW);

    const entries = ledger.posted[0]!.entries;
    const cash = entries.find((entry) => entry.accountId === `acct-cash-${GBP}`)!;
    const revenue = entries.find((entry) => entry.accountId === `acct-ticket_revenue-${GBP}`)!;

    // The mirror image of the sale's DEBIT cash / CREDIT revenue.
    expect(cash.isDebit).toBe(false);
    expect(revenue.isDebit).toBe(true);
    expect(cash.amount.equals(Money.of(9_500, GBP))).toBe(true);
    // Shares the sale's prefix, so one query nets everything for the order.
    expect(ledger.posted[0]!.reference).toBe('order:ord-1:refund');
  });

  it('locks the order row it is about to change', async () => {
    await useCase.execute('ord-1', NOW);

    expect(orders.lockedFor).toBe('ord-1');
    expect(orders.updated).toHaveLength(1);
  });

  it('refuses a second refund, whatever the caller retries with', async () => {
    await useCase.execute('ord-1', NOW);

    // The aggregate is already REFUNDED; no idempotency key changes that.
    await expect(useCase.execute('ord-1', NOW)).rejects.toThrow(InvalidStateTransition);
    expect(ledger.posted).toHaveLength(1);
    expect(seats.released).toHaveLength(1);
  });

  it('runs inside a transaction — a REFUNDED order with no entries is a lie', async () => {
    await useCase.execute('ord-1', NOW);

    expect(transaction.calls).toBe(1);
  });

  it('rejects an unknown order', async () => {
    orders.current = null;

    await expect(useCase.execute('ord-nope', NOW)).rejects.toThrow(OrderNotFound);
  });
});
