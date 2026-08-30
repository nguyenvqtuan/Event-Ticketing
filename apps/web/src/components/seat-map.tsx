'use client';

import { useState } from 'react';
import { type Seat } from '@repo/contracts';

/**
 * The seat map (TICK-F2).
 *
 * Read-only state, client-side selection. Actually holding the seats is
 * TICK-F3, so this deliberately stops at "here is what you picked" rather than
 * offering a button that does nothing.
 *
 * A client component because selection is interaction; the seats themselves
 * are fetched on the server and passed in, so the first paint already shows
 * real availability rather than a spinner that resolves to it.
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

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);

const STATE_LABEL = {
  AVAILABLE: 'available',
  HELD: 'held by someone else',
  SOLD: 'sold',
} as const;

export function SeatMap({ seats }: { seats: readonly Seat[] }) {
  const [selected, setSelected] = useState<readonly string[]>([]);

  const rows = toRows(seats);
  const chosen = seats.filter((seat) => selected.includes(seat.id));
  const total = chosen.reduce((sum, seat) => sum + seat.priceMinor, 0);
  const currency = chosen[0]?.currency ?? seats[0]?.currency ?? 'GBP';

  const toggle = (seat: Seat) => {
    if (seat.status !== 'AVAILABLE') return;

    setSelected((current) =>
      current.includes(seat.id)
        ? current.filter((id) => id !== seat.id)
        : // Capped to match the API, which refuses more than 20 per hold —
          // better to stop here than to let the request fail at 21.
          current.length >= MAX_SEATS
          ? current
          : [...current, seat.id],
    );
  };

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
              const disabled = seat.status !== 'AVAILABLE';

              return (
                <button
                  key={seat.id}
                  type="button"
                  className={`seat seat--${isSelected ? 'selected' : seat.status.toLowerCase()}`}
                  disabled={disabled}
                  aria-pressed={disabled ? undefined : isSelected}
                  // The state is in the accessible name, not only the colour.
                  aria-label={`Seat ${seat.code}, ${STATE_LABEL[seat.status]}, ${money(seat.priceMinor, seat.currency)}`}
                  title={`${seat.code} · ${STATE_LABEL[seat.status]} · ${money(seat.priceMinor, seat.currency)}`}
                  onClick={() => toggle(seat)}
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

      {chosen.length > 0 && (
        <div className="selection" role="status">
          <div>
            <strong>
              {chosen.length} seat{chosen.length === 1 ? '' : 's'} selected
            </strong>
            <span className="muted"> · {chosen.map((seat) => seat.code).join(', ')}</span>
            <div className="muted" style={{ fontSize: '0.875rem' }}>
              Total {money(total, currency)}
              {chosen.length >= MAX_SEATS && ` · ${MAX_SEATS} is the most you can hold at once`}
            </div>
          </div>
          <button type="button" className="back" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
    </>
  );
}

/** The API refuses more than 20 seats per reservation. */
const MAX_SEATS = 20;

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <li className="legend__item">
      <span className={`legend__swatch ${className}`} aria-hidden="true" />
      {label}
    </li>
  );
}
