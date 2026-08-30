'use client';

import { type Seat } from '@repo/contracts';

/**
 * The seat map (TICK-F2).
 *
 * Presentational: it draws seats and reports clicks. Selection state lives in
 * `BookingFlow` (TICK-F3), because the same selection drives the hold request
 * and has to survive the hold, the countdown and the payment — a component
 * that owned it privately would have to hand it back up anyway.
 *
 * The seats themselves are fetched on the server and passed in, so the first
 * paint already shows real availability rather than a spinner resolving to it.
 */

/**
 * `A12` → row `A`, number `12`. Codes come from `rowLabel()` in the domain.
 *
 * Exported for its own tests: the grouping below is the only real logic in
 * this file, and it is a pure function, so it does not need a DOM to check.
 */
export function splitCode(code: string): { row: string; number: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(code);
  if (!match) return { row: '?', number: 0 };

  return { row: match[1]!, number: Number(match[2]) };
}

/** Groups seats into rows, each sorted by seat number. */
export function toRows(seats: readonly Seat[]): { row: string; seats: Seat[] }[] {
  const rows = new Map<string, { seat: Seat; number: number }[]>();

  for (const seat of seats) {
    const { row, number } = splitCode(seat.code);
    const existing = rows.get(row) ?? [];
    existing.push({ seat, number });
    rows.set(row, existing);
  }

  return (
    [...rows.entries()]
      // Sort by label length first, so AA comes after Z rather than after A.
      .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
      .map(([row, entries]) => ({
        row,
        seats: entries.sort((a, b) => a.number - b.number).map((entry) => entry.seat),
      }))
  );
}

import { money } from '@/lib/money';

const STATE_LABEL = {
  AVAILABLE: 'available',
  HELD: 'held by someone else',
  SOLD: 'sold',
} as const;

export interface SeatMapProps {
  seats: readonly Seat[];
  selected: readonly string[];
  onToggle: (seat: Seat) => void;
  /** Locked while a hold or payment is in flight, and once seats are held. */
  disabled?: boolean;
}

export function SeatMap({ seats, selected, onToggle, disabled = false }: SeatMapProps) {
  const rows = toRows(seats);

  if (seats.length === 0) {
    return <p className="muted">This event has no seats.</p>;
  }

  return (
    <>
      <p className="stage">Stage</p>

      <div className="seat-map">
        {rows.map(({ row, seats: rowSeats }) => (
          <div className="seat-row" key={row}>
            <span className="seat-row__label" aria-hidden="true">
              {row}
            </span>
            {rowSeats.map((seat) => {
              const isSelected = selected.includes(seat.id);
              const unselectable = seat.status !== 'AVAILABLE' || disabled;

              return (
                <button
                  key={seat.id}
                  type="button"
                  className={`seat seat--${isSelected ? 'selected' : seat.status.toLowerCase()}`}
                  disabled={unselectable}
                  aria-pressed={unselectable ? undefined : isSelected}
                  // The state is in the accessible name, not only the colour.
                  aria-label={`Seat ${seat.code}, ${STATE_LABEL[seat.status]}, ${money(seat.priceMinor, seat.currency)}`}
                  title={`${seat.code} · ${STATE_LABEL[seat.status]} · ${money(seat.priceMinor, seat.currency)}`}
                  onClick={() => onToggle(seat)}
                >
                  {splitCode(seat.code).number}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <ul className="legend" style={{ listStyle: 'none', padding: 0 }}>
        <Legend className="seat--available" label="Available" />
        <Legend className="seat--selected" label="Selected" />
        <Legend className="seat--held" label="Held" />
        <Legend className="seat--sold" label="Sold" />
      </ul>
    </>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <li className="legend__item">
      <span className={`legend__swatch ${className}`} aria-hidden="true" />
      {label}
    </li>
  );
}
