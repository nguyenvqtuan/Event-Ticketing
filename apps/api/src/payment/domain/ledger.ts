import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { Money } from '../../shared/domain/money.js';

export type LedgerAccountId = string;

/**
 * Standard accounting classification. It determines what a debit *means*:
 * a debit increases an asset but decreases a liability.
 */
export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'EQUITY';

export type Direction = 'DEBIT' | 'CREDIT';

export class LedgerAccount {
  private constructor(
    readonly id: LedgerAccountId,
    readonly name: string,
    readonly type: AccountType,
    readonly currency: string,
  ) {}

  static open(params: {
    id: LedgerAccountId;
    name: string;
    type: AccountType;
    currency: string;
  }): LedgerAccount {
    if (!params.name.trim()) {
      throw new InvariantViolation('Ledger account requires a name');
    }

    return new LedgerAccount(params.id, params.name, params.type, params.currency);
  }
}

/**
 * A single posting: this much money, this direction, this account.
 *
 * Entries are immutable. Corrections are made by posting a reversing
 * transaction, never by editing history — an auditable ledger is append-only.
 */
export class LedgerEntry {
  private constructor(
    readonly accountId: LedgerAccountId,
    readonly direction: Direction,
    readonly amount: Money,
  ) {}

  static of(accountId: LedgerAccountId, direction: Direction, amount: Money): LedgerEntry {
    if (!amount.isPositive) {
      throw new InvariantViolation(
        `Ledger entries carry a positive amount and a direction, got: ${amount.toString()}`,
      );
    }

    return new LedgerEntry(accountId, direction, amount);
  }

  get isDebit(): boolean {
    return this.direction === 'DEBIT';
  }
}

/**
 * A balanced set of entries — the unit in which the ledger is written.
 *
 * The invariant is the whole point of double-entry: **debits must equal
 * credits**. Enforcing it in the constructor means an unbalanced transaction
 * cannot be represented in memory, let alone persisted.
 */
export class LedgerTransaction {
  private constructor(
    readonly id: string,
    readonly entries: readonly LedgerEntry[],
    readonly occurredAt: Date,
    readonly reference: string,
  ) {}

  static post(params: {
    id: string;
    entries: readonly LedgerEntry[];
    occurredAt: Date;
    reference: string;
    currency: string;
  }): LedgerTransaction {
    const { id, entries, occurredAt, reference, currency } = params;

    if (entries.length < 2) {
      throw new InvariantViolation('A ledger transaction needs at least two entries');
    }

    const debits = Money.sum(
      entries.filter((entry) => entry.isDebit).map((entry) => entry.amount),
      currency,
    );
    const credits = Money.sum(
      entries.filter((entry) => !entry.isDebit).map((entry) => entry.amount),
      currency,
    );

    if (!debits.equals(credits)) {
      throw new InvariantViolation(
        `Unbalanced transaction: debits ${debits.toString()} ≠ credits ${credits.toString()}`,
      );
    }
    if (debits.isZero) {
      throw new InvariantViolation('A ledger transaction cannot be for zero');
    }

    return new LedgerTransaction(id, [...entries], occurredAt, reference);
  }

  /** Sum of debits, which by the invariant equals the sum of credits. */
  get amount(): Money {
    return Money.sum(
      this.entries.filter((entry) => entry.isDebit).map((entry) => entry.amount),
      this.entries[0]!.amount.currency,
    );
  }
}
