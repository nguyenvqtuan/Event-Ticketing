import { InvariantViolation } from '../../shared/domain/domain-error.js';
import { type Money } from '../../shared/domain/money.js';

/** One seat to be created. Not yet a `Seat` — it has no identity until stored. */
export interface SeatBlueprint {
  readonly code: string;
  readonly price: Money;
}

export interface SeatMapSpec {
  readonly rows: number;
  readonly seatsPerRow: number;
  readonly price: Money;
}

/**
 * A generated map is written in one transaction, so an unbounded request would
 * hold locks for an unbounded time. 50k covers a large stadium.
 */
export const MAX_SEATS_PER_EVENT = 50_000;

/**
 * Spreadsheet-style row labels: 1→A, 26→Z, 27→AA.
 *
 * Wrapping to AA rather than running out at Z means a venue with more than 26
 * rows still gets stable, human-readable codes.
 */
export function rowLabel(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new InvariantViolation(`Row index must be a positive integer, got: ${index}`);
  }

  let label = '';
  let remaining = index;

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return label;
}

/**
 * Pure seat generation: a spec in, blueprints out. No database, no clock, no
 * identity — which is what makes it exhaustively unit-testable.
 *
 * Codes are unique within the map by construction, which is what lets the
 * database's unique (event_id, code) index make re-generation idempotent
 * rather than a conflict.
 */
export function generateSeatMap(spec: SeatMapSpec): SeatBlueprint[] {
  const { rows, seatsPerRow, price } = spec;

  if (!Number.isInteger(rows) || rows < 1) {
    throw new InvariantViolation(`rows must be a positive integer, got: ${rows}`);
  }
  if (!Number.isInteger(seatsPerRow) || seatsPerRow < 1) {
    throw new InvariantViolation(`seatsPerRow must be a positive integer, got: ${seatsPerRow}`);
  }
  if (price.amountMinor < 0) {
    throw new InvariantViolation(`Seat price cannot be negative: ${price.toString()}`);
  }

  const total = rows * seatsPerRow;
  if (total > MAX_SEATS_PER_EVENT) {
    throw new InvariantViolation(
      `A seat map may not exceed ${MAX_SEATS_PER_EVENT} seats, requested: ${total}`,
    );
  }

  const seats: SeatBlueprint[] = [];

  // Seat numbers are zero-padded to the width of the largest in the row.
  // Without this, codes sort lexicographically as A1, A10, A2 — which is the
  // order the seats listing would show them in, since ordering happens in SQL
  // on the code column. Padding makes lexicographic order the natural order.
  const width = String(seatsPerRow).length;

  for (let row = 1; row <= rows; row++) {
    const label = rowLabel(row);

    for (let seat = 1; seat <= seatsPerRow; seat++) {
      seats.push({ code: `${label}${String(seat).padStart(width, '0')}`, price });
    }
  }

  return seats;
}
