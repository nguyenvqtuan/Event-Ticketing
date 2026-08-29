import { InvariantViolation } from './domain-error.js';
import { Money } from './money.js';

const GBP = 'GBP';

describe('Money', () => {
  it('rejects fractional minor units', () => {
    expect(() => Money.of(10.5, GBP)).toThrow(InvariantViolation);
  });

  it('requires a currency', () => {
    expect(() => Money.of(100, '')).toThrow(InvariantViolation);
  });

  it('adds without floating-point drift', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in minor units it is exact.
    const total = Money.of(10, GBP).plus(Money.of(20, GBP));

    expect(total.amountMinor).toBe(30);
  });

  it('sums a long list exactly', () => {
    const tenPence = Array.from({ length: 100 }, () => Money.of(10, GBP));

    expect(Money.sum(tenPence, GBP).amountMinor).toBe(1_000);
  });

  it('refuses to combine different currencies', () => {
    expect(() => Money.of(100, GBP).plus(Money.of(100, 'EUR'))).toThrow(/Cannot combine/);
  });

  it('subtracts, allowing a negative result for ledger use', () => {
    expect(Money.of(100, GBP).minus(Money.of(150, GBP)).amountMinor).toBe(-50);
  });

  it('compares by value, not identity', () => {
    expect(Money.of(100, GBP).equals(Money.of(100, GBP))).toBe(true);
    expect(Money.of(100, GBP).equals(Money.of(100, 'EUR'))).toBe(false);
  });

  it('is immutable — arithmetic returns a new instance', () => {
    const original = Money.of(100, GBP);
    original.plus(Money.of(50, GBP));

    expect(original.amountMinor).toBe(100);
  });

  it('formats for humans', () => {
    expect(Money.of(9_500, GBP).toString()).toBe('95.00 GBP');
  });
});
