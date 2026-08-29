/**
 * A port for "do all of this, or none of it".
 *
 * The application layer needs transaction *boundaries* — TICK-7's AC requires
 * an event and its seats to be created atomically — without knowing what a
 * transaction is made of. The Drizzle adapter supplies the mechanism.
 */
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
