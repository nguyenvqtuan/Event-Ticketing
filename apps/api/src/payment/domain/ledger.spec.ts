import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerAccount, LedgerEntry, LedgerTransaction } from './ledger.js';

const GBP = 'GBP';
const money = (minor: number) => Money.of(minor, GBP);

const CASH = 'acct-cash';
const REVENUE = 'acct-revenue';

describe('LedgerAccount', () => {
  it('opens with a name, a type and a currency', () => {
    const account = LedgerAccount.open({
      id: CASH,
      name: 'cash',
      type: 'ASSET',
      currency: GBP,
    });

    expect(account.id).toBe(CASH);
    expect(account.name).toBe('cash');
    expect(account.type).toBe('ASSET');
    // Currency is part of the account's identity: "cash" in GBP and "cash" in
    // EUR are different accounts, as migration 0004's unique index enforces.
    expect(account.currency).toBe(GBP);
  });

  it('rejects a blank name', () => {
    expect(() =>
      LedgerAccount.open({ id: CASH, name: '  ', type: 'ASSET', currency: GBP }),
    ).toThrow(InvariantViolation);
  });
});

describe('LedgerEntry', () => {
  it('carries a positive amount plus a direction, never a signed amount', () => {
    const entry = LedgerEntry.of(CASH, 'DEBIT', money(5_000));

    expect(entry.isDebit).toBe(true);
    expect(entry.amount.amountMinor).toBe(5_000);
  });

  it('rejects a negative amount — direction encodes the sign', () => {
    expect(() => LedgerEntry.of(CASH, 'DEBIT', money(-1))).toThrow(InvariantViolation);
  });

  it('rejects a zero amount', () => {
    expect(() => LedgerEntry.of(CASH, 'CREDIT', money(0))).toThrow(InvariantViolation);
  });
});

describe('LedgerTransaction', () => {
  const post = (entries: LedgerEntry[]) =>
    LedgerTransaction.post({
      id: 'txn-1',
      entries,
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      reference: 'order-1',
      currency: GBP,
    });

  it('accepts a balanced transaction', () => {
    const txn = post([
      LedgerEntry.of(CASH, 'DEBIT', money(5_000)),
      LedgerEntry.of(REVENUE, 'CREDIT', money(5_000)),
    ]);

    expect(txn.entries).toHaveLength(2);
    expect(txn.amount.equals(money(5_000))).toBe(true);
  });

  it('accepts a split across several accounts as long as it balances', () => {
    const txn = post([
      LedgerEntry.of(CASH, 'DEBIT', money(5_000)),
      LedgerEntry.of(REVENUE, 'CREDIT', money(4_500)),
      LedgerEntry.of('acct-fees', 'CREDIT', money(500)),
    ]);

    expect(txn.amount.equals(money(5_000))).toBe(true);
  });

  it('REFUSES an unbalanced transaction — the core double-entry invariant', () => {
    expect(() =>
      post([
        LedgerEntry.of(CASH, 'DEBIT', money(5_000)),
        LedgerEntry.of(REVENUE, 'CREDIT', money(4_999)),
      ]),
    ).toThrow(/Unbalanced/);
  });

  it('refuses a single-sided transaction', () => {
    expect(() => post([LedgerEntry.of(CASH, 'DEBIT', money(5_000))])).toThrow(
      /at least two entries/,
    );
  });

  it('accepts entries that individually net to zero, since the transaction does not', () => {
    expect(() =>
      post([
        LedgerEntry.of(CASH, 'DEBIT', money(1)),
        LedgerEntry.of(CASH, 'CREDIT', money(1)),
        LedgerEntry.of(REVENUE, 'DEBIT', money(1)),
        LedgerEntry.of(REVENUE, 'CREDIT', money(1)),
      ]),
    ).not.toThrow(); // balanced and non-zero: debits = credits = 2
  });

  it('copies its entries, so the caller cannot append after posting', () => {
    const entries = [
      LedgerEntry.of(CASH, 'DEBIT', money(100)),
      LedgerEntry.of(REVENUE, 'CREDIT', money(100)),
    ];
    const txn = post(entries);

    entries.push(LedgerEntry.of(CASH, 'DEBIT', money(999)));

    expect(txn.entries).toHaveLength(2);
  });
});
