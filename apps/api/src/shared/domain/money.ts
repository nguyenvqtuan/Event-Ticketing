import { InvariantViolation } from './domain-error.js';

/** ISO-4217 code. Kept as a plain string; validation is at the edges. */
export type Currency = string;

/**
 * An amount of money, stored in **minor units** (cents), never as a float.
 *
 * Floating point cannot represent 0.1 exactly, so summing prices in a
 * ticketing ledger drifts. Integers do not drift, and a double-entry ledger
 * that does not balance to the cent is worthless.
 *
 * Part of the shared kernel: both Inventory and Payment depend on it, and
 * both mean exactly the same thing by it.
 */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: Currency,
  ) {}

  static of(amountMinor: number, currency: Currency): Money {
    if (!Number.isInteger(amountMinor)) {
      throw new InvariantViolation(`Money must be whole minor units (cents), got: ${amountMinor}`);
    }
    if (!currency) {
      throw new InvariantViolation('Money requires a currency');
    }

    return new Money(amountMinor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  /** Sums amounts, refusing to mix currencies. */
  static sum(amounts: readonly Money[], currency: Currency): Money {
    return amounts.reduce((total, next) => total.plus(next), Money.zero(currency));
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  negated(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  equals(other: Money): boolean {
    return this.amountMinor === other.amountMinor && this.currency === other.currency;
  }

  get isPositive(): boolean {
    return this.amountMinor > 0;
  }

  get isZero(): boolean {
    return this.amountMinor === 0;
  }

  toString(): string {
    return `${(this.amountMinor / 100).toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvariantViolation(`Cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}
