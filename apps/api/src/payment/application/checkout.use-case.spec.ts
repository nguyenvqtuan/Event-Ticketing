import { InvalidStateTransition } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { type TransactionRunner } from '../../shared/domain/transaction-runner.port.js';
import { type LedgerTransaction } from '../domain/ledger.js';
import { type Order } from '../domain/order.js';
import {
  type ClaimedSeats,
  type LedgerRepository,
  type OrderRepository,
  type SeatClaimPort,
} from '../domain/payment-repository.port.js';
import { AmountMismatch, CheckoutUseCase } from './checkout.use-case.js';

/**
 * The critical path, with the database replaced by fakes.
 *
 * The integration suite proves this works against real transactions and
 * constraints; what is worth isolating here are the decisions and the
 * ordering — that a mismatched amount stops before anything is written, and
 * that seats, order and ledger move together or not at all.
 */
const GBP = 'GBP';
const NOW = new Date('2026-03-01T12:00:00.000Z');

class FakeSeats implements SeatClaimPort {
  claimed: ClaimedSeats = {
    reservationId: 'res-1',
    eventId: 'evt-1',
    holderId: 'holder-1',
    lines: [
      { seatId: 'seat-1', seatCode: 'A1', price: Money.of(5_000, GBP) },
      { seatId: 'seat-2', seatCode: 'A2', price: Money.of(4_500, GBP) },
    ],
  };
  claimedAt: Date | null = null;
  released: string[] = [];

  claimForPayment(_reservationId: string, now: Date) {
    this.claimedAt = now;
    return Promise.resolve(this.claimed);
  }
  releaseSeats(reservationId: string) {
    this.released.push(reservationId);
    return Promise.resolve();
  }
}

class FakeOrders implements OrderRepository {
  saved: Order[] = [];
  save(order: Order) {
    this.saved.push(order);
    return Promise.resolve();
  }
  findByReservationId() {
    return Promise.resolve(null);
  }
  findByIdForUpdate() {
    return Promise.resolve(null);
  }
  updateState() {
    return Promise.resolve();
  }
}

class FakeLedger implements LedgerRepository {
  posted: LedgerTransaction[] = [];
  failWith: Error | null = null;

  post(transaction: LedgerTransaction) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.posted.push(transaction);
    return Promise.resolve();
  }
  accountId(name: string, currency: string) {
    return Promise.resolve(`acct-${name}-${currency}`);
  }
}

/** Rolls back by discarding the work's effects, as a transaction would. */
class FakeTransaction implements TransactionRunner {
  rolledBack = false;
  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.rolledBack = true;
      throw error;
    }
  }
}

describe('CheckoutUseCase', () => {
  let seats: FakeSeats;
  let orders: FakeOrders;
  let ledger: FakeLedger;
  let transaction: FakeTransaction;
  let useCase: CheckoutUseCase;

  const pay = (amountMinor = 9_500, currency = GBP) =>
    useCase.execute({ reservationId: 'res-1', amountMinor, currency, now: NOW });

  beforeEach(() => {
    seats = new FakeSeats();
    orders = new FakeOrders();
    ledger = new FakeLedger();
    transaction = new FakeTransaction();
    useCase = new CheckoutUseCase(seats, orders, ledger, transaction);
  });

  it('sells the seats, pays the order and posts the revenue', async () => {
    const result = await pay();

    expect(result.state).toBe('PAID');
    expect(result.total.equals(Money.of(9_500, GBP))).toBe(true);
    expect(result.seatIds).toEqual(['seat-1', 'seat-2']);
    expect(orders.saved).toHaveLength(1);
    expect(ledger.posted).toHaveLength(1);
  });

  it('prices the order from the claimed seats, not from the amount offered', async () => {
    const order = (await pay(), orders.saved[0]!);

    expect(order.lines.map((line) => line.seatCode)).toEqual(['A1', 'A2']);
    expect(order.total.equals(Money.of(9_500, GBP))).toBe(true);
  });

  it('posts a balanced pair: debit cash, credit revenue', async () => {
    await pay();

    const entries = ledger.posted[0]!.entries;
    const debit = entries.find((entry) => entry.isDebit)!;
    const credit = entries.find((entry) => !entry.isDebit)!;

    expect(debit.accountId).toBe(`acct-cash-${GBP}`);
    expect(credit.accountId).toBe(`acct-ticket_revenue-${GBP}`);
    expect(debit.amount.equals(credit.amount)).toBe(true);
    // Referenced so the sale and any later refund net out under one prefix.
    expect(ledger.posted[0]!.reference).toMatch(/^order:.+:sale$/);
  });

  it('REFUSES an amount that does not match what the seats cost', async () => {
    await expect(pay(9_499)).rejects.toThrow(AmountMismatch);
  });

  it('writes nothing when the amount is wrong — the check precedes the writes', async () => {
    await expect(pay(9_499)).rejects.toThrow(AmountMismatch);

    expect(orders.saved).toHaveLength(0);
    expect(ledger.posted).toHaveLength(0);
  });

  it('rolls back the whole checkout when the ledger write fails', async () => {
    ledger.failWith = new Error('ledger unavailable');

    await expect(pay()).rejects.toThrow('ledger unavailable');

    // The order was saved inside the transaction that then rolled back: a
    // ticket the books have no record of is the failure this ordering exists
    // to make impossible.
    expect(transaction.rolledBack).toBe(true);
  });

  it('lets Inventory refuse a hold that cannot be paid', async () => {
    seats.claimForPayment = () =>
      Promise.reject(new InvalidStateTransition('Reservation res-1 is EXPIRED'));

    await expect(pay()).rejects.toThrow(InvalidStateTransition);
    expect(orders.saved).toHaveLength(0);
  });

  it('passes the caller its clock, so expiry is judged against one time', async () => {
    await pay();

    expect(seats.claimedAt).toBe(NOW);
  });
});
